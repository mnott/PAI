import { describe, it, expect } from "vitest";
import { editAssist, isEditAssistError, editHintFor } from "./edit-assist.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("editAssist", () => {
  it("returns a specific message when strings are identical", () => {
    const result = editAssist({
      oldString: "hello world",
      newString: "hello world",
      errorText: "No changes to make: old_string and new_string are exactly the same",
      fileText: null
    });
    expect(result).toBe("old_string and new_string are identical: the file already contains your intended text; check whether this step is done (grep for it) before editing again.");
  });

  it("returns a region hint when string not found and fileText is provided", () => {
    const fileText = `line 1
line 2
line 3
line 4
line 5`;

    const result = editAssist({
      oldString: "line 2",
      newString: "line 2 modified",
      errorText: "String to replace not found in file",
      fileText
    });

    expect(result).toContain("closest region of the file (lines");
    expect(result).toContain("copy old_string from here exactly, including whitespace:");
    expect(result).toContain("2\tline 2");
  });

  it("returns a not found message when no similar line exists", () => {
    const fileText = `line 1
line 2
line 3
line 4
line 5`;

    const result = editAssist({
      oldString: "nonexistent line",
      newString: "new line",
      errorText: "String to replace not found in file",
      fileText
    });

    expect(result).toContain("old_string not found and no similar line exists in the file");
    expect(result).toContain("re-read the file (Read) before editing again.");
  });

  it("includes deletion hint when deleting and no similar line exists", () => {
    const fileText = `line 1
line 2
line 3
line 4
line 5`;

    const result = editAssist({
      oldString: "nonexistent line",
      newString: "",
      errorText: "String to replace not found in file",
      fileText
    });

    expect(result).toContain("old_string not found and no similar line exists in the file");
    expect(result).toContain("if you are deleting this, grep for it first: it may already be gone.");
  });

  it("returns null when fileText is null and newString is not empty", () => {
    const result = editAssist({
      oldString: "some text",
      newString: "new text",
      errorText: "String to replace not found in file",
      fileText: null
    });

    expect(result).toBeNull();
  });

  it("includes deletion hint when fileText is null and newString is empty", () => {
    const result = editAssist({
      oldString: "some text",
      newString: "",
      errorText: "String to replace not found in file",
      fileText: null
    });

    expect(result).toBe("if you are deleting this, grep for it first: it may already be gone.");
  });

  it("returns null for unrelated errors", () => {
    const result = editAssist({
      oldString: "some text",
      newString: "new text",
      errorText: "Some unrelated error",
      fileText: null
    });

    expect(result).toBeNull();
  });

  it("handles blank lines in oldString correctly", () => {
    const result = editAssist({
      oldString: "\n\n\n",
      newString: "new text",
      errorText: "String to replace not found in file",
      fileText: "line 1\nline 2"
    });

    expect(result).toBeNull();
  });

  it("handles empty oldString correctly", () => {
    const result = editAssist({
      oldString: "",
      newString: "new text",
      errorText: "String to replace not found in file",
      fileText: "line 1\nline 2"
    });

    expect(result).toBeNull();
  });
});

describe("isEditAssistError", () => {
  it("returns true for identical strings error", () => {
    expect(isEditAssistError("No changes to make: old_string and new_string are exactly the same")).toBe(true);
  });

  it("returns true for not found error", () => {
    expect(isEditAssistError("String to replace not found in file")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isEditAssistError("Some unrelated error")).toBe(false);
  });
});

describe("editHintFor", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "edit-hint-"));
  const filePath = join(tempDir, "a.ts");
  writeFileSync(filePath, `function foo() {
  return 1;
}
const bar = 2;`);

  it("returns a hint with line numbers when string to replace not found", () => {
    const result = editHintFor({file_path:"a.ts", old_string:"  return 2;", new_string:"  return 3;"}, "String to replace not found in file", tempDir);
    expect(result).toContain("2\t");
    expect(result).toContain("return 1;");
  });

  it("returns a hint about already containing text when strings are identical", () => {
    const result = editHintFor({file_path:"a.ts", old_string:"  return 1;", new_string:"  return 1;"}, "No changes to make: old_string and new_string are exactly the same", tempDir);
    expect(result).toContain("already contains your intended text");
  });

  it("returns null when file does not exist", () => {
    const result = editHintFor({file_path:"missing.ts", old_string:"  return 2;", new_string:"  return 3;"}, "String to replace not found in file", tempDir);
    expect(result).toBeNull();
  });

  it("returns null when file does not exist and error is about file not existing", () => {
    const result = editHintFor({file_path:"missing.ts", old_string:"  return 2;", new_string:"  return 3;"}, "File does not exist", tempDir);
    expect(result).toBeNull();
  });

  it("includes deletion hint when deleting and file path is correct", () => {
    const result = editHintFor({file_path:"a.ts", old_string:"  return 2;", new_string:""}, "String to replace not found in file", tempDir);
    expect(result).toContain("it may already be gone.");
  });
});