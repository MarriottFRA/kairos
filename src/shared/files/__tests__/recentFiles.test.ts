/**
 * Remembered-file bookkeeping, shared by the BST Pull and the BST Push.
 *
 * The whole point of remembering a path is to save the user the file dialog,
 * and the whole risk of it is offering one that would be refused the moment
 * they click it. These tests pin both halves: the list stays clean and ordered,
 * and a file is only suggested where it would actually be accepted — which for
 * the push means matching the budget year too, and for the pull does not.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_RECENT_FILES,
  RecentFile,
  baseName,
  findRecentFile,
  forgetRecentFile,
  normalizeRecentFiles,
  parentPath,
  recentFilesForOu,
  rememberRecentFile,
} from "../recentFiles";
import { normalizeBstPushConfig } from "../../bstPush/ipc";

const file = (over: Partial<RecentFile> = {}): RecentFile => ({
  filePath: "C:\\Budgets\\2026\\BST OU12345.xlsm",
  fileName: "BST OU12345.xlsm",
  ou: "OU12345",
  year: 2026,
  usedAt: 1_000,
  ...over,
});

describe("path helpers", () => {
  it("reads the name and folder off a Windows path", () => {
    expect(baseName("C:\\Budgets\\2026\\BST.xlsm")).toBe("BST.xlsm");
    expect(parentPath("C:\\Budgets\\2026\\BST.xlsm")).toBe("C:\\Budgets\\2026");
  });

  it("reads the name and folder off a POSIX path", () => {
    expect(baseName("/mnt/share/BST.xlsm")).toBe("BST.xlsm");
    expect(parentPath("/mnt/share/BST.xlsm")).toBe("/mnt/share");
  });

  it("treats a bare name as having no folder", () => {
    expect(parentPath("BST.xlsm")).toBe("");
  });
});

describe("normalizeRecentFiles", () => {
  it("drops entries missing the things a guard-safe offer needs", () => {
    expect(
      normalizeRecentFiles([
        { ...file(), filePath: "" },
        { ...file(), ou: "nonsense" },
        "not an object",
        null,
      ])
    ).toEqual([]);
  });

  it("keeps a year-less entry — the pull declares no year", () => {
    const [entry] = normalizeRecentFiles([{ ...file(), year: undefined }]);
    expect(entry.year).toBeNull();
  });

  it("canonicalizes a bare OU and derives a missing file name", () => {
    const [entry] = normalizeRecentFiles([
      { filePath: "/share/BST.xlsm", ou: "12345", year: 2026, usedAt: 5 },
    ]);
    expect(entry.ou).toBe("OU12345");
    expect(entry.fileName).toBe("BST.xlsm");
  });

  it("keeps the newest visit per path and orders newest first", () => {
    const files = normalizeRecentFiles([
      file({ filePath: "/a", usedAt: 10 }),
      file({ filePath: "/A", usedAt: 40 }),
      file({ filePath: "/b", usedAt: 20 }),
    ]);
    expect(files.map((f) => f.usedAt)).toEqual([40, 20]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_RECENT_FILES + 5 }, (_u, i) =>
      file({ filePath: `/f${i}`, usedAt: i + 1 })
    );
    expect(normalizeRecentFiles(many)).toHaveLength(MAX_RECENT_FILES);
  });

  it("survives a corrupt stored value", () => {
    expect(normalizeRecentFiles("garbage")).toEqual([]);
    expect(normalizeBstPushConfig({}).recentFiles).toEqual([]);
  });
});

describe("rememberRecentFile", () => {
  it("moves a repeat visit to the front instead of duplicating it", () => {
    const before = [file({ filePath: "/a", usedAt: 10 }), file({ filePath: "/b", usedAt: 20 })];
    const after = rememberRecentFile(before, file({ filePath: "/a", usedAt: 99 }));
    expect(after.map((f) => f.filePath)).toEqual(["/a", "/b"]);
    expect(after[0].usedAt).toBe(99);
  });
});

describe("forgetRecentFile", () => {
  it("drops the path however it was cased", () => {
    const after = forgetRecentFile([file({ filePath: "/a" }), file({ filePath: "/b" })], "/A");
    expect(after.map((f) => f.filePath)).toEqual(["/b"]);
  });
});

describe("findRecentFile", () => {
  const files = [
    file({ filePath: "/2026", ou: "OU12345", year: 2026, usedAt: 30 }),
    file({ filePath: "/2025", ou: "OU12345", year: 2025, usedAt: 20 }),
    file({ filePath: "/other", ou: "OU99999", year: 2026, usedAt: 40 }),
  ];

  it("offers the file for this hotel and this year", () => {
    expect(findRecentFile(files, "OU12345", 2026)?.filePath).toBe("/2026");
  });

  it("never offers another hotel's file, however recent", () => {
    expect(findRecentFile(files, "OU12345", 2027)).toBeNull();
    expect(findRecentFile(files, "OU00000", 2026)).toBeNull();
  });

  it("ignores the year when the flow does not guard on one", () => {
    // The pull's shape: newest file for the hotel, whatever year it declared.
    expect(findRecentFile(files, "OU12345")?.filePath).toBe("/2026");
    expect(
      findRecentFile([file({ filePath: "/x", year: null, usedAt: 9 })], "OU12345")
        ?.filePath
    ).toBe("/x");
  });

  it("never offers a year-less file where a year is required", () => {
    expect(
      findRecentFile([file({ filePath: "/x", year: null })], "OU12345", 2026)
    ).toBeNull();
  });

  it("accepts the bare OU form the switcher may hold", () => {
    expect(findRecentFile(files, "12345", 2026)?.filePath).toBe("/2026");
  });

  it("offers nothing without a hotel", () => {
    expect(findRecentFile(files, null, 2026)).toBeNull();
  });
});

describe("recentFilesForOu", () => {
  it("narrows an install-wide store to one hotel", () => {
    const files = [
      file({ filePath: "/mine", ou: "OU12345" }),
      file({ filePath: "/theirs", ou: "OU99999" }),
    ];
    expect(recentFilesForOu(files, "OU12345").map((f) => f.filePath)).toEqual([
      "/mine",
    ]);
    expect(recentFilesForOu(files, null)).toEqual([]);
  });
});
