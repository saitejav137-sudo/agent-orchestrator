import { describe, it, expect } from "vitest";
import { classifyAiderTerminalOutput } from "../index.js";

describe("classifyAiderTerminalOutput", () => {
    // -------------------------------------------------------------------------
    // Idle states
    // -------------------------------------------------------------------------

    it("returns idle for empty output", () => {
        expect(classifyAiderTerminalOutput("")).toBe("idle");
        expect(classifyAiderTerminalOutput("   ")).toBe("idle");
        expect(classifyAiderTerminalOutput("\n\n")).toBe("idle");
    });

    it("returns idle for aider prompt", () => {
        expect(classifyAiderTerminalOutput("aider> ")).toBe("idle");
        expect(classifyAiderTerminalOutput("> ")).toBe("idle");
        expect(classifyAiderTerminalOutput("some output\naider> ")).toBe("idle");
    });

    // -------------------------------------------------------------------------
    // Blocked states (errors, stuck)
    // -------------------------------------------------------------------------

    it("detects API key errors as blocked", () => {
        expect(classifyAiderTerminalOutput("No API key found for model X")).toBe("blocked");
        expect(classifyAiderTerminalOutput("Error: API key is invalid")).toBe("blocked");
        expect(classifyAiderTerminalOutput("Authentication failed. Check your credentials.")).toBe("blocked");
    });

    it("detects rate limits as blocked", () => {
        expect(classifyAiderTerminalOutput("Rate limit exceeded, please wait")).toBe("blocked");
        expect(classifyAiderTerminalOutput("Error: Quota exceeded for this model")).toBe("blocked");
    });

    it("detects model errors as blocked", () => {
        expect(classifyAiderTerminalOutput("Model not found: minimax/MiniMax-Text-01")).toBe("blocked");
        expect(classifyAiderTerminalOutput("Unknown model: gpt-5-turbo")).toBe("blocked");
        expect(classifyAiderTerminalOutput("Unsupported model specified")).toBe("blocked");
    });

    it("detects connection errors as blocked", () => {
        expect(classifyAiderTerminalOutput("Connection refused to api.openai.com")).toBe("blocked");
        expect(classifyAiderTerminalOutput("Connection timeout after 30s")).toBe("blocked");
        expect(classifyAiderTerminalOutput("Network error: unable to reach server")).toBe("blocked");
    });

    it("detects Python tracebacks as blocked", () => {
        const traceback = `Traceback (most recent call last):
  File "/usr/lib/python3/aider/main.py", line 42, in main
    raise ValueError("bad config")
ValueError: bad config`;
        expect(classifyAiderTerminalOutput(traceback)).toBe("blocked");
    });

    it("detects generic errors as blocked", () => {
        expect(classifyAiderTerminalOutput("Error: Something went wrong")).toBe("blocked");
        expect(classifyAiderTerminalOutput("Unauthorized access")).toBe("blocked");
    });

    // -------------------------------------------------------------------------
    // Waiting for input states
    // -------------------------------------------------------------------------

    it("detects OpenRouter auth prompts as waiting_input", () => {
        expect(classifyAiderTerminalOutput("Please login to OpenRouter to get your API key")).toBe("waiting_input");
        expect(classifyAiderTerminalOutput("Opening browser for OpenRouter auth...")).toBe("waiting_input");
    });

    it("detects file add prompts as waiting_input", () => {
        expect(classifyAiderTerminalOutput("Would you like to add foo.ts to the chat?")).toBe("waiting_input");
    });

    it("detects file creation prompts as waiting_input", () => {
        expect(classifyAiderTerminalOutput("Create new file src/utils.ts?")).toBe("waiting_input");
    });

    it("detects URL prompts as waiting_input", () => {
        expect(classifyAiderTerminalOutput("Would you like to scrape this URL?")).toBe("waiting_input");
    });

    it("detects yes/no prompts as waiting_input", () => {
        expect(classifyAiderTerminalOutput("Continue? (Y)es / (N)o")).toBe("waiting_input");
        expect(classifyAiderTerminalOutput("Proceed? [y/n]")).toBe("waiting_input");
        expect(classifyAiderTerminalOutput("Do you want to continue?")).toBe("waiting_input");
    });

    // -------------------------------------------------------------------------
    // Active states
    // -------------------------------------------------------------------------

    it("returns active for normal output", () => {
        expect(classifyAiderTerminalOutput("Thinking about your request...")).toBe("active");
        expect(classifyAiderTerminalOutput("Editing file src/main.ts")).toBe("active");
        expect(classifyAiderTerminalOutput("Applied changes to 3 files")).toBe("active");
    });

    // -------------------------------------------------------------------------
    // Edge cases — only check the tail (last 10 lines)
    // -------------------------------------------------------------------------

    it("only checks the tail of the output", () => {
        // Error far up in the buffer should not affect detection
        const output = [
            "No API key found", // old error — should be ignored
            ...(Array(15).fill("Thinking...")), // enough lines to push error out of tail
            "Applied changes to foo.ts",
        ].join("\n");
        expect(classifyAiderTerminalOutput(output)).toBe("active");
    });
});
