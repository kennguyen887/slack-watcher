import { handleCodeRequest } from "./code-request.js";
import { handlePrReview } from "./pr-review.js";
import { handleNeedsClarification } from "./clarification.js";

// Classification kind → handler. Kinds with no entry are logged but not acted on ("ignore").
// Teammates' questions are not answered here — a scheduled Claude task handles them.
export const HANDLERS = {
  code_request: handleCodeRequest,
  pr_review: handlePrReview,
  needs_clarification: handleNeedsClarification,
};
