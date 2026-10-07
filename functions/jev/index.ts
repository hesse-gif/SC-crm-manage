// TypeSafe/JEV product-integration surface.
//   - jevTypes.ts    : request/response contract + strict parsing/validation
//   - jevClient.ts   : single egress chokepoint (gateway preferred, direct opt-in) + usage logging
//   - jevDecision.ts : fail-closed send/no-send + template-selection adapter, restrictive-only gate
export * from "./jevTypes";
export * from "./jevClient";
export * from "./jevDecision";
