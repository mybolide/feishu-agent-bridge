/**
 * 模拟用户场景测试：
 * 1. 启动网关
 * 2. 外部创建文件
 * 3. 通过 ls 命令查看
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import assert from "node:assert";

// 模拟 listEntries 函数（从 navigation.js 复制）
function listEntries(targetPath) {
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
}

const TEST_DIR = path.join(process.cwd(), "test-freshness-dir");

describe("模拟用户场景：外部创建文件后 ls 查看", () => {
  before(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
    // 清空
    for (const entry of fs.readdirSync(TEST_DIR)) {
      fs.rmSync(path.join(TEST_DIR, entry), { recursive: true, force: true });
    }
  });

  after(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("场景1：在 Windows 资源管理器创建文件夹后立即 ls", async () => {
    console.log("\n=== 场景1：Windows 资源管理器创建 ===");
    
    // 1. 记录初始状态
    const before = listEntries(TEST_DIR);
    console.log(`初始状态: ${before.dirs.length} 文件夹, ${before.files.length} 文件`);
    
    // 2. 用户在资源管理器创建文件夹（我们模拟）
    const newFolder = path.join(TEST_DIR, `新建文件夹-${Date.now()}`);
    console.log(`正在创建: ${newFolder}`);
    fs.mkdirSync(newFolder);
    
    // 3. 立即执行 ls（模拟用户操作）
    const after = listEntries(TEST_DIR);
    console.log(`创建后立即 ls: ${after.dirs.length} 文件夹, ${after.files.length} 文件`);
    console.log(`文件夹列表: ${after.dirs.join(", ") || "(空)"}`);
    
    assert.ok(after.dirs.some(d => d.startsWith("新建文件夹")), "应该能看到新文件夹");
  });

  it("场景2：创建嵌套文件夹后 cd 进入", async () => {
    console.log("\n=== 场景2：嵌套文件夹 ===");
    
    // 创建嵌套结构
    const nested = path.join(TEST_DIR, "parent", "child");
    fs.mkdirSync(nested, { recursive: true });
    console.log(`创建嵌套: ${nested}`);
    
    // 在子目录创建文件
    fs.writeFileSync(path.join(nested, "test.txt"), "hello");
    console.log(`创建文件: ${path.join(nested, "test.txt")}`);
    
    // 分别检查各级目录
    const root = listEntries(TEST_DIR);
    const parent = listEntries(path.join(TEST_DIR, "parent"));
    const child = listEntries(path.join(TEST_DIR, "parent", "child"));
    
    console.log(`根目录: ${root.dirs.join(", ")}`);
    console.log(`parent: ${parent.dirs.join(", ")}, ${parent.files.join(", ")}`);
    console.log(`child: ${child.files.join(", ")}`);
    
    assert.ok(root.dirs.includes("parent"), "根目录应有 parent");
    assert.ok(parent.dirs.includes("child"), "parent 应有 child");
    assert.ok(child.files.includes("test.txt"), "child 应有 test.txt");
  });

  it("场景3：检查是否有路径混淆", async () => {
    console.log("\n=== 场景3：路径检查 ===");
    
    // 检查 path.resolve 的行为
    const cwd = process.cwd();
    console.log(`process.cwd(): ${cwd}`);
    
    const resolved = path.resolve(TEST_DIR);
    console.log(`path.resolve(TEST_DIR): ${resolved}`);
    
    // 检查大小写敏感性（Windows 不区分，但路径字符串可能不同）
    const upperCase = TEST_DIR.toUpperCase();
    const lowerCase = TEST_DIR.toLowerCase();
    
    console.log(`大写路径: ${upperCase}`);
    console.log(`小写路径: ${lowerCase}`);
    console.log(`fs.existsSync(大写): ${fs.existsSync(upperCase)}`);
    console.log(`fs.existsSync(小写): ${fs.existsSync(lowerCase)}`);
    
    // 读取比较
    const upperEntries = fs.readdirSync(upperCase);
    const lowerEntries = fs.readdirSync(lowerCase);
    
    console.log(`大写路径读取: ${upperEntries.length} 条目`);
    console.log(`小写路径读取: ${lowerEntries.length} 条目`);
    
    assert.deepStrictEqual(upperEntries, lowerEntries, "大小写路径应返回相同结果");
  });

  it("场景4：延迟读取测试", async () => {
    console.log("\n=== 场景4：延迟读取 ===");
    
    // 创建文件
    const file = path.join(TEST_DIR, `delayed-${Date.now()}.txt`);
    fs.writeFileSync(file, "test");
    console.log(`创建文件: ${file}`);
    
    // 等待不同时间后读取
    const times = [0, 100, 500, 1000];
    for (const ms of times) {
      if (ms > 0) {
        await new Promise(r => setTimeout(r, ms));
      }
      const entries = listEntries(TEST_DIR);
      const found = entries.files.some(f => f.startsWith("delayed-"));
      console.log(`等待 ${ms}ms 后: 找到=${found}, 文件数=${entries.files.length}`);
    }
  });

  it("场景5：检查文件系统缓存刷新", async () => {
    console.log("\n=== 场景5：文件系统缓存 ===");
    
    // 先读取一次建立缓存
    const first = listEntries(TEST_DIR);
    console.log(`首次读取: ${first.files.length} 文件`);
    
    // 创建新文件
    const newFile = path.join(TEST_DIR, `cache-test-${Date.now()}.txt`);
    fs.writeFileSync(newFile, "cache test");
    console.log(`创建: ${newFile}`);
    
    // 再次读取（不等待）
    const second = listEntries(TEST_DIR);
    console.log(`二次读取: ${second.files.length} 文件`);
    
    // 检查新文件是否出现
    const found = second.files.some(f => f.startsWith("cache-test-"));
    console.log(`新文件找到: ${found}`);
    
    assert.ok(found, "新文件应该立即可见");
    
    // 清理
    fs.unlinkSync(newFile);
  });
});