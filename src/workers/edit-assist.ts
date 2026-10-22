export interface EditAssistInput {
  oldString: string;
  newString: string;
  errorText: string;
  fileText: string | null;
}

/**
 * Returns a human-readable hint for an edit error, or null if the error is not
 * one that this helper knows how to handle.
 */
export function editAssist(i: EditAssistInput): string | null {
  if (i.errorText.includes("No changes to make: old_string and new_string are exactly the same")) {
    return "old_string and new_string are identical: the file already contains your intended text; check whether this step is done (grep for it) before editing again.";
  }

  if (i.errorText.includes("String to replace not found in file") && i.fileText !== null) {
    // Split oldString into lines, drop blank (whitespace-only) lines; if none, return null.
    const lines = i.oldString.split("\n");
    const nonBlankLines = lines.filter(line => line.trim() !== "");
    if (nonBlankLines.length === 0) {
      return null;
    }

    // first = trimmed first non-blank line, last = trimmed last non-blank line.
    const first = nonBlankLines[0].trim();
    const last = nonBlankLines[nonBlankLines.length - 1].trim();

    // Split fileText into lines.
    const fileLines = i.fileText.split("\n");

    // Find the best matching file line index for `first` and for `last`
    const findBestMatch = (target: string): number | null => {
      let bestIndex: number | null = null;
      let bestSimilarity = -1;

      for (let i = 0; i < fileLines.length; i++) {
        const trimmedLine = fileLines[i].trim();
        if (trimmedLine === target) {
          return i; // Exact match wins
        }

        const similarity = computeSimilarity(target, trimmedLine);
        if (similarity >= 0.5 && similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestIndex = i;
        }
      }

      return bestIndex;
    };

    const firstIndex = findBestMatch(first);
    const lastIndex = findBestMatch(last);

    // Check if we're deleting
    const deleting = i.newString.trim() === "";

    // If neither anchor is found return "old_string not found and no similar line exists in the file"
    if (firstIndex === null && lastIndex === null) {
      let result = "old_string not found and no similar line exists in the file; re-read the file (Read) before editing again.";
      if (deleting) {
        result += "\nif you are deleting this, grep for it first: it may already be gone.";
      }
      return result;
    }

    // Otherwise, determine the region
    let startIndex: number = firstIndex !== null ? firstIndex : lastIndex!;
    let endIndex: number = lastIndex !== null ? lastIndex : firstIndex!;

    // For `last`, prefer a match at an index >= the first's index when several tie
    if (lastIndex !== null && firstIndex !== null && lastIndex < firstIndex) {
      startIndex = lastIndex;
      endIndex = firstIndex;
    }

    // Widen by 3 lines of context each side (clamped), cap at 40 lines
    const context = 3;
    startIndex = Math.max(0, startIndex - context);
    endIndex = Math.min(fileLines.length - 1, endIndex + context);

    // Cap at 40 lines
    const regionLength = endIndex - startIndex + 1;
    if (regionLength > 40) {
      const half = Math.floor(40 / 2);
      startIndex = Math.max(0, (firstIndex ?? lastIndex ?? 0) - half);
      endIndex = Math.min(fileLines.length - 1, startIndex + 39);
    }

    // Render the region
    const regionLines = [];
    for (let i = startIndex; i <= endIndex; i++) {
      regionLines.push(`${i + 1}\t${fileLines[i]}`);
    }

    const header = `closest region of the file (lines ${startIndex + 1}-${endIndex + 1}), copy old_string from here exactly, including whitespace:`;
    return `${header}\n${regionLines.join("\n")}${deleting ? "\nif you are deleting this, grep for it first: it may already be gone." : ""}`;
  }

  // Deletion hint for when the edit is a deletion
  if (i.errorText.includes("String to replace not found in file") && i.fileText === null) {
    if (i.newString.trim() === "") {
      return "if you are deleting this, grep for it first: it may already be gone.";
    }
    return null;
  }

  // Any other errorText returns null
  return null;
}

/**
 * Computes similarity between two strings based on longest common prefix and suffix.
 * Similarity = (length of longest common prefix + length of longest common suffix) / max(length of both strings)
 */
export function computeSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  // Longest common prefix
  let prefixLength = 0;
  const minLength = Math.min(s1.length, s2.length);
  for (let i = 0; i < minLength; i++) {
    if (s1[i] === s2[i]) {
      prefixLength++;
    } else {
      break;
    }
  }

  // Longest common suffix
  let suffixLength = 0;
  const s1Reversed = s1.split('').reverse().join('');
  const s2Reversed = s2.split('').reverse().join('');
  for (let i = 0; i < minLength; i++) {
    if (s1Reversed[i] === s2Reversed[i]) {
      suffixLength++;
    } else {
      break;
    }
  }

  // prefix and suffix must not overlap, or the sum can exceed the length
  const overlapCap = minLength - prefixLength;
  const totalLength = Math.max(s1.length, s2.length);
  return (prefixLength + Math.min(suffixLength, overlapCap)) / totalLength;
}

/**
 * Checks if an error text is one that editAssist can handle.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function isEditAssistError(errorText: string): boolean {
  return errorText.includes("No changes to make: old_string and new_string are exactly the same") ||
         errorText.includes("String to replace not found in file");
}

/** Hint for a failed Edit tool call: reads the target file under cwd and delegates to editAssist; null when it has nothing to add. */
export function editHintFor(input: unknown, errorText: string, cwd: string): string | null {
  if (!isEditAssistError(errorText) || typeof input !== "object" || input === null) return null;
  const i = input as Record<string, unknown>;
  const oldString = typeof i.old_string === "string" ? i.old_string : "";
  const newString = typeof i.new_string === "string" ? i.new_string : "";
  let fileText: string | null = null;
  if (typeof i.file_path === "string") {
    try { fileText = readFileSync(resolve(cwd, i.file_path), "utf8"); } catch { fileText = null; }
  }
  return editAssist({ oldString, newString, errorText, fileText });
}