// Local emulator entry for the Mixmaxclone Flu backend copy.
//
// Import the upstream Flu index so every callable keeps the original wrapper,
// auth boundary, response/error projection, and handler wiring. Export only
// callable functions plus the auth bootstrap trigger. Schedules, public HTTP
// endpoints, and Firestore workers are intentionally not re-exported, so the
// Firebase emulator discovery surface cannot run duplicate production workers.
//
// This file is local-only. Production traffic uses the existing Flu deployment;
// do not deploy this copied backend.

import * as flu from "./index";

type EndpointExport = ((...args: unknown[]) => unknown) & {
  __endpoint?: Record<string, unknown>;
  __trigger?: Record<string, unknown>;
};

function isEndpointExport(value: unknown): value is EndpointExport {
  return typeof value === "function" && value !== null;
}

function isCallableEndpoint(value: EndpointExport): boolean {
  return Boolean(value.__endpoint?.callableTrigger);
}

function stripSecretManagerMetadataForLocalEmulator(value: EndpointExport): void {
  const endpointDescriptor = Object.getOwnPropertyDescriptor(value, "__endpoint");
  const endpoint = endpointDescriptor && "value" in endpointDescriptor
    ? endpointDescriptor.value as Record<string, unknown> | undefined
    : undefined;
  if (endpoint && typeof endpoint === "object") {
    delete endpoint.secretEnvironmentVariables;
  }
}

const selectedExports: Record<string, EndpointExport> = {};

for (const [name, value] of Object.entries(flu)) {
  if (!isEndpointExport(value)) continue;
  if (name === "assignGuestClaims") {
    selectedExports[name] = value;
    continue;
  }
  if (isCallableEndpoint(value)) {
    stripSecretManagerMetadataForLocalEmulator(value);
    selectedExports[name] = value;
  }
}

Object.assign(exports, selectedExports);
