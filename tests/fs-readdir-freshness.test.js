/**
 * 测试 fs.readdirSync 是否能读取到最新文件
 * 用于排查 ls/cd 命令"缓存"问题
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

const TEST_DIR = path.join(process.cwd(), ".test-fs-readdir");

describe("fs.readdirSync 实时性测试", () => {
  before(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  after(() => {
    // 清理测试目录
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // 每个测试前清空目录
    const entries = fs.readdirSync(TEST_DIR);
    for (const entry of entries) {
      fs.rmSync(path.join(TEST_DIR, entry), { recursive: true, force: true });
    }
  });

  it("应该能立即读取到新创建的文件夹", () => {
    // 1. 读取初始列表
    const before = fs.readdirSync(TEST_DIR);
    console.log(`[test] 创建前: ${before.length} 个条目`);
    assert.strictEqual(before.length, 0, "初始应该为空");

    // 2. 创建新文件夹
    const newDir = path.join(TEST_DIR, "new-folder");
    fs.mkdirSync(newDir);
    console.log(`[test] 已创建: ${newDir}`);

    // 3. 立即读取
    const after = fs.readdirSync(TEST_DIR);
    console.log(`[test] 创建后: ${after.length} 个条目, 内容: ${after.join(", ")}`);
    
    assert.strictEqual(after.length, 1, "应该有1个条目");
    assert.strictEqual(after[0], "new-folder", "应该是新创建的文件夹");
  });

  it("应该能立即读取到新创建的文件", () => {
    // 1. 读取初始列表
    const before = fs.readdirSync(TEST_DIR);
    console.log(`[test] 创建前: ${before.length} 个条目`);
    assert.strictEqual(before.length, 0, "初始应该为空");

    // 2. 创建新文件
    const newFile = path.join(TEST_DIR, "new-file.txt");
    fs.writeFileSync(newFile, "test content");
    console.log(`[test] 已创建: ${newFile}`);

    // 3. 立即读取
    const after = fs.readdirSync(TEST_DIR);
    console.log(`[test] 创建后: ${after.length} 个条目, 内容: ${after.join(", ")}`);
    
    assert.strictEqual(after.length, 1, "应该有1个条目");
    assert.strictEqual(after[0], "new-file.txt", "应该是新创建的文件");
  });

  it("应该能读取到外部创建的文件（模拟用户场景）", async () => {
    // 1. 读取初始列表
    const before = fs.readdirSync(TEST_DIR);
    console.log(`[test] 创建前: ${before.length} 个条目`);
    assert.strictEqual(before.length, 0, "初始应该为空");

    // 2. 模拟外部创建（通过子进程）
    const { execSync } = await import("node:child_process");
    const newDir = path.join(TEST_DIR, "external-folder");
    
    if (process.platform === "win32") {
      execSync(`mkdir "${newDir}"`, { shell: true });
    } else {
      execSync(`mkdir -p "${newDir}"`, { shell: true });
    }
    console.log(`[test] 外部创建: ${newDir}`);

    // 3. 立即读取
    const after = fs.readdirSync(TEST_DIR);
    console.log(`[test] 创建后: ${after.length} 个条目, 内容: ${after.join(", ")}`);
    
    assert.strictEqual(after.length, 1, "应该有1个条目");
    assert.strictEqual(after[0], "external-folder", "应该是外部创建的文件夹");
  });

  it("listEntries 函数应该返回最新内容", async () => {
    // 动态导入 navigation.js 中的 listEntries（如果可以）
    // 由于它是非导出函数，我们模拟相同逻辑
    
    const listEntries = (targetPath) => {
      const dirs = [];
      const files = [];
      const hiddenDirs = new Set([".oc_trash", ".git"]);
      const names = fs.readdirSync(targetPath, { encoding: "utf8" });
      for (const rawName of names) {
        const name = String(rawName || "");
        if (hiddenDirs.has(name)) {
          continue;
        }
        const fullPath = path.join(targetPath, name);
        let stat = null;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          dirs.push(name);
        } else if (stat.isFile()) {
          files.push(name);
        }
      }
      dirs.sort((a, b) => a.localeCompare(b, "zh-CN"));
      files.sort((a, b) => a.localeCompare(b, "zh-CN"));
      return { dirs, files };
    };

    // 1. 初始状态
    const before = listEntries(TEST_DIR);
    console.log(`[test] 创建前: dirs=${before.dirs.length}, files=${before.files.length}`);

    // 2. 创建多个文件和文件夹
    fs.mkdirSync(path.join(TEST_DIR, "dir1"));
    fs.mkdirSync(path.join(TEST_DIR, "dir2"));
    fs.writeFileSync(path.join(TEST_DIR, "file1.txt"), "content");
    fs.writeFileSync(path.join(TEST_DIR, "file2.txt"), "content");

    // 3. 立即读取
    const after = listEntries(TEST_DIR);
    console.log(`[test] 创建后: dirs=${after.dirs.length} [${after.dirs.join(", ")}], files=${after.files.length} [${after.files.join(", ")}]`);
    
    assert.strictEqual(after.dirs.length, 2, "应该有2个文件夹");
    assert.strictEqual(after.files.length, 2, "应该有2个文件");
    assert.ok(after.dirs.includes("dir1"), "应该包含 dir1");
    assert.ok(after.dirs.includes("dir2"), "应该包含 dir2");
    assert.ok(after.files.includes("file1.txt"), "应该包含 file1.txt");
    assert.ok(after.files.includes("file2.txt"), "应该包含 file2.txt");
  });

  it("测试 withFileTypes 选项", () => {
    // 使用 withFileTypes 选项测试
    const before = fs.readdirSync(TEST_DIR, { withFileTypes: true });
    console.log(`[test] withFileTypes 创建前: ${before.length} 个条目`);

    // 创建文件夹和文件
    fs.mkdirSync(path.join(TEST_DIR, "test-dir"));
    fs.writeFileSync(path.join(TEST_DIR, "test-file.txt"), "content");

    const after = fs.readdirSync(TEST_DIR, { withFileTypes: true });
    console.log(`[test] withFileTypes 创建后: ${after.length} 个条目`);
    
    for (const entry of after) {
      console.log(`[test]   - ${entry.name} (isDir: ${entry.isDirectory()}, isFile: ${entry.isFile()})`);
    }

    assert.strictEqual(after.length, 2, "应该有2个条目");
  });
});