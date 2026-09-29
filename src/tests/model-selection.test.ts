import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { curatedProviders, selectModel } from "../model-selection.js";

test("curated provider defaults resolve to models in the installed Pi catalog", () => {
  const models = builtinModels();
  for (const item of curatedProviders) {
    const selected = selectModel(item.id, undefined);
    assert.equal(selected.piProvider, item.piProvider);
    assert.equal(selected.modelId, item.defaultModel);
    assert.equal(selected.defaulted, true);
    assert.ok(models.getModel(selected.piProvider, selected.modelId), `${item.id} default disappeared from Pi catalog`);
  }
});

test("explicit model overrides default, and unknown providers need a model ID", () => {
  assert.equal(selectModel("deepseek", "deepseek-v4-pro").modelId, "deepseek-v4-pro");
  assert.equal(selectModel("deepseek", "deepseek-v4-pro").defaulted, false);
  assert.throws(() => selectModel("other", undefined), /no VibeGuard default model/);
  assert.deepEqual(selectModel("other", "model-id"), {
    requestedProvider: "other", piProvider: "other", modelId: "model-id", defaulted: false,
  });
});
