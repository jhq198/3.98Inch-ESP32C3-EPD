"use strict";

const SERVICE_UUID = "7b4d0001-6a6c-4c61-9f20-65706463616c";
const CONTROL_UUID = "7b4d0002-6a6c-4c61-9f20-65706463616c";
const NOTIFY_UUID = "7b4d0003-6a6c-4c61-9f20-65706463616c";
const RESPONSE_TIMEOUT_MS = 10000;
const WIFI_POLL_INTERVAL_MS = 2500;
const WIFI_POLL_ATTEMPTS = 48;

const statusElement = document.querySelector("#status");
const deviceStateElement = document.querySelector("#device-state");
const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const submitButton = document.querySelector("#submit");
const clearButton = document.querySelector("#clear");
const wifiForm = document.querySelector("#wifi-form");
const ssidInput = document.querySelector("#ssid");
const passwordInput = document.querySelector("#password");

let bluetoothDevice = null;
let controlCharacteristic = null;
let receiveBuffer = new Uint8Array(0);
let nextSequence = 1;
let pendingRequest = null;
let commandBusy = false;

function setStatus(message, kind = "") {
  statusElement.textContent = message;
  statusElement.dataset.kind = kind;
}

function setConnected(connected) {
  connectButton.disabled = connected || !navigator.bluetooth;
  disconnectButton.disabled = !connected;
  submitButton.disabled = !connected || commandBusy;
  clearButton.disabled = !connected || commandBusy;
}

function crc16Ccitt(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

function makeFrame(type, sequence, payload) {
  const frame = new Uint8Array(10 + payload.length);
  const view = new DataView(frame.buffer);
  frame[0] = 0x45;
  frame[1] = 0x50;
  frame[2] = 0x01;
  frame[3] = type;
  view.setUint16(4, sequence, true);
  view.setUint16(6, payload.length, true);
  frame.set(payload, 8);
  view.setUint16(frame.length - 2, crc16Ccitt(frame.subarray(0, frame.length - 2)), true);
  return frame;
}

function appendReceiveData(value) {
  const combined = new Uint8Array(receiveBuffer.length + value.length);
  combined.set(receiveBuffer);
  combined.set(value, receiveBuffer.length);
  receiveBuffer = combined;
  parseReceiveBuffer();
}

function parseReceiveBuffer() {
  while (receiveBuffer.length >= 10) {
    let start = -1;
    for (let i = 0; i < receiveBuffer.length - 1; i += 1) {
      if (receiveBuffer[i] === 0x45 && receiveBuffer[i + 1] === 0x50) {
        start = i;
        break;
      }
    }

    if (start < 0) {
      receiveBuffer = receiveBuffer.at(-1) === 0x45
        ? receiveBuffer.slice(-1)
        : new Uint8Array(0);
      return;
    }
    if (start > 0) receiveBuffer = receiveBuffer.slice(start);
    if (receiveBuffer.length < 10) return;

    const view = new DataView(receiveBuffer.buffer, receiveBuffer.byteOffset, receiveBuffer.byteLength);
    const payloadLength = view.getUint16(6, true);
    if (receiveBuffer[2] !== 0x01 || payloadLength > 1024) {
      receiveBuffer = receiveBuffer.slice(1);
      continue;
    }

    const frameLength = 10 + payloadLength;
    if (receiveBuffer.length < frameLength) return;
    const frame = receiveBuffer.slice(0, frameLength);
    const frameView = new DataView(frame.buffer);
    const expectedCrc = frameView.getUint16(frameLength - 2, true);
    if (crc16Ccitt(frame.subarray(0, frameLength - 2)) !== expectedCrc) {
      receiveBuffer = receiveBuffer.slice(1);
      continue;
    }

    receiveBuffer = receiveBuffer.slice(frameLength);
    handleResponse(frame[3], frameView.getUint16(4, true), frame.slice(8, frameLength - 2));
  }
}

function handleResponse(type, sequence, payload) {
  if (!pendingRequest || type !== (pendingRequest.type | 0x80) || sequence !== pendingRequest.sequence) return;
  const request = pendingRequest;
  pendingRequest = null;
  clearTimeout(request.timeoutId);

  if (payload.length < 1) {
    request.reject(new Error("设备返回了空响应"));
  } else if (payload[0] !== 0) {
    request.reject(new Error(`设备拒绝命令，状态码 ${payload[0]}`));
  } else {
    request.resolve(payload.slice(1));
  }
}

function rejectPendingRequest(error) {
  if (!pendingRequest) return;
  const request = pendingRequest;
  pendingRequest = null;
  clearTimeout(request.timeoutId);
  request.reject(error);
}

async function sendCommand(type, payload = new Uint8Array(0)) {
  if (!controlCharacteristic) throw new Error("请先连接设备");
  if (pendingRequest) throw new Error("上一条命令尚未完成，请稍后重试");

  const sequence = nextSequence;
  nextSequence = (nextSequence + 1) & 0xffff;
  if (nextSequence === 0) nextSequence = 1;

  const response = new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (pendingRequest?.sequence === sequence) {
        pendingRequest = null;
        reject(new Error("等待设备响应超时，请确认设备仍在连接范围内"));
      }
    }, RESPONSE_TIMEOUT_MS);
    pendingRequest = { type, sequence, resolve, reject, timeoutId };
  });

  try {
    const frame = makeFrame(type, sequence, payload);
    if (typeof controlCharacteristic.writeValueWithResponse === "function") {
      await controlCharacteristic.writeValueWithResponse(frame);
    } else {
      await controlCharacteristic.writeValue(frame);
    }
    return await response;
  } catch (error) {
    if (pendingRequest?.sequence === sequence) {
      clearTimeout(pendingRequest.timeoutId);
      pendingRequest = null;
    }
    throw error;
  }
}

function parseDeviceInfo(data) {
  if (data.length < 6 || data[0] !== 1) throw new Error("设备信息格式不受支持");
  const flags = data[4];
  return {
    connected: (flags & 0x01) !== 0,
    hasCredentials: (flags & 0x10) !== 0,
  };
}

async function refreshDeviceState() {
  const info = parseDeviceInfo(await sendCommand(0x01));
  deviceStateElement.textContent = `Wi-Fi 状态：${info.connected ? "已连接" : "未连接"}；`
    + `设备${info.hasCredentials ? "已保存" : "未保存"} Wi-Fi 凭据`;
  return info;
}

function onDisconnected() {
  rejectPendingRequest(new Error("蓝牙连接已断开"));
  bluetoothDevice = null;
  controlCharacteristic = null;
  receiveBuffer = new Uint8Array(0);
  commandBusy = false;
  deviceStateElement.textContent = "Wi-Fi 状态：未知";
  setConnected(false);
  setStatus("设备已断开连接", "");
}

async function connectDevice() {
  if (!navigator.bluetooth) {
    setStatus("此浏览器不支持 Web Bluetooth，请使用 HTTPS 下的 Chrome 或 Edge", "error");
    return;
  }

  try {
    setStatus("正在扫描设备…", "working");
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    bluetoothDevice.addEventListener("gattserverdisconnected", onDisconnected);
    const server = await bluetoothDevice.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    controlCharacteristic = await service.getCharacteristic(CONTROL_UUID);
    const notifyCharacteristic = await service.getCharacteristic(NOTIFY_UUID);
    notifyCharacteristic.addEventListener("characteristicvaluechanged", (event) => {
      appendReceiveData(new Uint8Array(event.target.value.buffer,
        event.target.value.byteOffset, event.target.value.byteLength));
    });
    await notifyCharacteristic.startNotifications();
    setConnected(true);
    setStatus(`已连接：${bluetoothDevice.name || "EPD-Calendar"}`, "success");
    await refreshDeviceState();
  } catch (error) {
    if (bluetoothDevice?.gatt?.connected) bluetoothDevice.gatt.disconnect();
    else {
      bluetoothDevice = null;
      controlCharacteristic = null;
      setConnected(false);
    }
    setStatus(error.name === "NotFoundError" ? "未选择设备" : `连接失败：${error.message}`, "error");
  }
}

async function waitForWifiConnection() {
  for (let attempt = 0; attempt < WIFI_POLL_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, WIFI_POLL_INTERVAL_MS));
    if (!controlCharacteristic) return;
    try {
      const info = await refreshDeviceState();
      if (info.connected) {
        setStatus("Wi-Fi 已连接成功", "success");
        return;
      }
    } catch (error) {
      setStatus(`查询 Wi-Fi 状态失败：${error.message}`, "error");
      return;
    }
  }
  if (controlCharacteristic) {
    setStatus("设备仍未报告 Wi-Fi 已连接。可检查密码或路由器后重新提交。", "error");
  }
}

function encodeCredentialField(value, label, maximumLength, allowEmpty) {
  const bytes = new TextEncoder().encode(value);
  if ((!allowEmpty && bytes.length === 0) || bytes.length > maximumLength) {
    throw new Error(`${label}长度不符合要求（最多 ${maximumLength} 字节）`);
  }
  if (bytes.some((byte) => byte === 0 || byte < 0x20 || byte === 0x7f)) {
    throw new Error(`${label}不能包含 NUL 或 ASCII 控制字符`);
  }
  return bytes;
}

async function submitCredentials(event) {
  event.preventDefault();
  if (commandBusy) return;

  let ssid;
  let password;
  try {
    ssid = encodeCredentialField(ssidInput.value, "SSID", 32, false);
    password = encodeCredentialField(passwordInput.value, "密码", 64, true);
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }

  const payload = new Uint8Array(2 + ssid.length + password.length);
  payload[0] = ssid.length;
  payload[1] = password.length;
  payload.set(ssid, 2);
  payload.set(password, 2 + ssid.length);
  passwordInput.value = "";

  commandBusy = true;
  setConnected(Boolean(controlCharacteristic));
  setStatus("正在保存 Wi-Fi 凭据…", "working");
  try {
    await sendCommand(0x08, payload);
    setStatus("凭据已保存，设备正在连接 Wi-Fi…", "working");
    await waitForWifiConnection();
  } catch (error) {
    setStatus(`配网失败：${error.message}`, "error");
  } finally {
    commandBusy = false;
    setConnected(Boolean(controlCharacteristic));
  }
}

async function clearCredentials() {
  if (commandBusy || !controlCharacteristic) return;
  if (!window.confirm("确定清除设备中已保存的 Wi-Fi 凭据？")) return;

  commandBusy = true;
  setConnected(true);
  setStatus("正在清除 Wi-Fi 凭据…", "working");
  try {
    await sendCommand(0x08, new Uint8Array([0, 0]));
    deviceStateElement.textContent = "Wi-Fi 状态：凭据已清除";
    setStatus("设备中的 Wi-Fi 凭据已清除", "success");
  } catch (error) {
    setStatus(`清除失败：${error.message}`, "error");
  } finally {
    commandBusy = false;
    setConnected(Boolean(controlCharacteristic));
  }
}

connectButton.addEventListener("click", connectDevice);
disconnectButton.addEventListener("click", () => bluetoothDevice?.gatt?.disconnect());
wifiForm.addEventListener("submit", submitCredentials);
clearButton.addEventListener("click", clearCredentials);
setConnected(false);

if (!window.isSecureContext) {
  setStatus("Web Bluetooth 需要 HTTPS 安全连接", "error");
} else if (!navigator.bluetooth) {
  setStatus("此浏览器不支持 Web Bluetooth，请使用 HTTPS 下的 Chrome 或 Edge", "error");
}
