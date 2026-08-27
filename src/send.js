#!/usr/bin/env node
// Push a message to Slack as you — to a channel by name, a user DM by username, or a raw ID.
//
// CLI:
//   node src/send.js "#dev-channel" "deployed, please verify"
//   node src/send.js "@teammate" "PR is up: <link>"
//   echo "multiline message" | node src/send.js "#dev-channel" -
//   printf '%s' "$MSG" | node src/send.js --cap 300 "#dev-channel" -
//
// Targets: "#channel-name" | "@username" (also matches display/real name; needs users:read
// scope) | raw C…/D…/U… ID. Messages are sent from YOUR account — review before sending.
//
// Guards (there is no chat.delete in this tool, so a bad send can only be cleaned up by
// hand in front of everyone who already read it — refuse it here instead):
//   --cap N               refuse messages longer than N characters (default 2000, the
//                         team's report ceiling; review pings pass --cap 300)
//   SEND_ALLOWED_TARGETS  optional .env allowlist ("#chan-a,#chan-b,@name"); when set,
//                         any target not on the list is refused before the network
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { createSlackClient } from "./slack.js";

export const DEFAULT_CAP = 2000;

// Code points, matching how `wc -m` counts — an em dash or arrow is 1, not 3.
export const countChars = (text) => [...text].length;

/** Returns an error string, or null when the send is allowed. */
export function validateSend(to, text, { cap = DEFAULT_CAP, allowedTargets = [] } = {}) {
  if (!to || !text) return "both target and message are required";
  const length = countChars(text);
  if (length > cap) {
    return `message is ${length} chars, over the ${cap} cap — trim it (or raise --cap if this is a report, ceiling ${DEFAULT_CAP})`;
  }
  if (allowedTargets.length > 0) {
    const wanted = to.toLowerCase();
    if (!allowedTargets.some((t) => t.toLowerCase() === wanted)) {
      return `target ${to} is not in SEND_ALLOWED_TARGETS (${allowedTargets.join(", ")}) — sends cannot be deleted, so unlisted targets are refused`;
    }
  }
  return null;
}

export async function sendSlackMessage(slack, to, text) {
  if (!to || !text) throw new Error("both target and message are required");
  const channel = to.startsWith("@") ? await slack.resolveUserId(to) : to;
  return slack.post(channel, text);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) {
  const args = process.argv.slice(2);
  let cap = DEFAULT_CAP;
  const capAt = args.indexOf("--cap");
  if (capAt !== -1) {
    cap = Number.parseInt(args[capAt + 1], 10);
    if (!Number.isInteger(cap) || cap <= 0) {
      console.error("--cap needs a positive integer");
      process.exit(1);
    }
    args.splice(capAt, 2);
  }

  const [to, ...rest] = args;
  let text = rest.join(" ");
  if (text === "-" || (!text && !process.stdin.isTTY)) text = fs.readFileSync(0, "utf8").trim();
  if (!to || !text) {
    console.error(
      'usage: send.js [--cap N] <"#channel" | "@username" | ID> <message... | ->   (- reads stdin)',
    );
    process.exit(1);
  }

  const config = loadConfig();
  const refusal = validateSend(to, text, { cap, allowedTargets: config.sendAllowedTargets });
  if (refusal) {
    console.error(`refused: ${refusal}`);
    process.exit(1);
  }

  const slack = createSlackClient(config.slackToken);
  sendSlackMessage(slack, to, text)
    .then((channel) => console.log(`sent to ${to} (${channel}) — ${countChars(text)} chars`))
    .catch((err) => {
      console.error(`failed: ${err.message}`);
      process.exit(1);
    });
}
