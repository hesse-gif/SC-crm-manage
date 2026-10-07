import assert from "node:assert/strict";
import test from "node:test";
import { projectConversationRecordForClient, projectConversationMessageForClient } from "../functions/lib/read.js";

const privateValue = "private@example.test?token=secret";
const caseIds = ["interest_next_steps", "submission_support", "requirements_question", "eligibility_question", "reward_overview"];

for (const [kind, project] of [
  ["conversation", projectConversationRecordForClient],
  ["message", projectConversationMessageForClient],
]) {
  test(`Permit ${kind} projection bounds review cards and hides private evidence`, () => {
    const result = project({
      id: "permit-projection", from: "creator", text: "Hello",
      caseId: caseIds[0],
      autoRepliedCaseIds: [caseIds[0], caseIds[0], privateValue],
      permitDenyReasons: ["permit_missing", privateValue, "permit_missing"],
      clampReasonIds: ["unsupported_fact_token", privateValue],
      caseCandidates: caseIds.map(caseId => ({
        caseId, title: privateValue, reasonCode: privateValue,
        clampReasonIds: ["unsupported_factual_claim", privateValue], rawPrompt: privateValue,
      })),
      caseIntentRef: privateValue, permitDecisionId: privateValue,
      gatewayModelVersion: privateValue, gatewayLedgerRef: privateValue,
      draftCandidateHash: privateValue, evalEvidence: { prompt: privateValue },
    });
    assert.equal(result.caseId, caseIds[0]);
    assert.deepEqual(result.autoRepliedCaseIds, [caseIds[0]]);
    assert.deepEqual(result.permitDenyReasons, ["permit_missing"]);
    assert.deepEqual(result.clampReasonIds, ["unsupported_fact_token"]);
    assert.equal(result.caseCandidates.length, 4);
    assert.equal(result.caseCandidates[0].title, "interest next steps");
    assert.equal(result.caseCandidates[0].reasonCode, "needs_review");
    assert.ok(!JSON.stringify(result).includes(privateValue));
    for (const key of ["caseIntentRef", "permitDecisionId", "gatewayModelVersion", "gatewayLedgerRef", "draftCandidateHash", "evalEvidence"]) {
      assert.ok(!(key in result), key);
    }
  });

  test(`Permit ${kind} projection rejects malformed and unknown review data`, () => {
    const result = project({
      caseId: privateValue,
      caseCandidates: [null, [], { caseId: privateValue }, { caseId: caseIds[0] }, { caseId: caseIds[0] }],
      autoRepliedCaseIds: [null, {}, privateValue],
      clampReasonIds: { injected: privateValue },
    });
    assert.ok(!("caseId" in result));
    assert.equal(result.caseCandidates.length, 1);
    assert.deepEqual(result.autoRepliedCaseIds, []);
    assert.ok(!JSON.stringify(result).includes(privateValue));
  });
}
