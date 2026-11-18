"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");
const { TextEncoder } = require("node:util");

function loadProvisioningApp(bluetooth = {}) {
  const elements = new Map();
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) {
        elements.set(selector, {
          addEventListener(type, listener) {
            this.listeners ??= {};
            this.listeners[type] = listener;
          },
          dataset: {},
          disabled: false,
          textContent: "",
          value: "",
        });
      }
      return elements.get(selector);
    },
  };
  const context = vm.createContext({
    TextEncoder,
    clearTimeout,
    document,
    navigator: { bluetooth },
    setTimeout,
    window: { isSecureContext: true, confirm: () => true },
  });
  vm.runInContext(readFileSync("docs/provisioning.js", "utf8"), context);
  context.testElements = elements;
  return context;
}

test("protocol CRC-16/CCITT matches the standard check value", () => {
  const context = loadProvisioningApp();
  assert.equal(vm.runInContext(
    "crc16Ccitt(new TextEncoder().encode('123456789'))",
    context,
  ), 0x29b1);
});

test("command response parser handles fragmented notifications and checks sequence", async () => {
  const context = loadProvisioningApp();
  vm.runInContext(`
    controlCharacteristic = {
      writeValueWithResponse: async (request) => {
        const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
        const response = makeFrame(request[3] | 0x80, view.getUint16(4, true),
          new Uint8Array([0, 0x2a]));
        appendReceiveData(response.slice(0, 4));
        appendReceiveData(response.slice(4));
      }
    };
  `, context);

  const result = await vm.runInContext(
    "sendCommand(0x08, new Uint8Array([1, 0, 0x41]))",
    context,
  );
  assert.deepEqual(Array.from(result), [0x2a]);
});

test("credential fields enforce encoded byte limits and reject control characters", () => {
  const context = loadProvisioningApp();
  assert.equal(vm.runInContext(
    "encodeCredentialField('中', 'SSID', 3, false).length",
    context,
  ), 3);
  assert.throws(() => vm.runInContext(
    "encodeCredentialField('中'.repeat(11), 'SSID', 32, false)",
    context,
  ), /SSID长度不符合要求/);
  assert.throws(() => vm.runInContext(
    "encodeCredentialField('wifi\\nname', 'SSID', 32, false)",
    context,
  ), /ASCII 控制字符/);
});

test("device chooser includes all nearby BLE devices and permits GATT service access", async () => {
  let requestOptions;
  const bluetooth = {
    async requestDevice(options) {
      requestOptions = options;
      const error = new Error("No matching devices");
      error.name = "NotFoundError";
      throw error;
    },
  };
  const context = loadProvisioningApp(bluetooth);
  const connectButton = context.testElements.get("#connect");

  await connectButton.listeners.click();

  assert.deepEqual(JSON.parse(JSON.stringify(requestOptions)), {
    acceptAllDevices: true,
    optionalServices: ["7b4d0001-6a6c-4c61-9f20-65706463616c"],
  });
  assert.match(context.testElements.get("#status").textContent, /未发现蓝牙设备或已取消选择/);
});
