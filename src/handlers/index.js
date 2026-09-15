import { handleCodeRequest } from "./code-request.js";
import { handlePrReview } from "./pr-review.js";
import { handleNeedsClarification } from "./clarification.js";
import { handleQuestion } from "./question.js";

// Classification kind → handler. Kinds with no entry are logged but not acted on ("ignore").
// "question" answers Vietnamese teammates in the thread, in the user's own learned voice, and
// hands everything else — every English-speaking teammate, and anything needing a human decision
// — back to the user as a private draft.
export const HANDLERS = {
  code_request: handleCodeRequest,
  pr_review: handlePrReview,
  needs_clarification: handleNeedsClarification,
  question: handleQuestion,
};
