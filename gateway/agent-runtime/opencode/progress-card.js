function formatElapsedHms(totalSeconds) {
    const sec = Math.max(0, Number.parseInt(String(totalSeconds || 0), 10) || 0);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
export function createOpenCodeProgressCard({ status, elapsedSeconds = 0, detail = "", latestOutput = "" }) {
    const statusText = {
        queued: "🕒 排队中",
        running: "⏳ 执行中",
        aborting: "⏹ 终止中",
        completed: "✅ 执行完成",
        aborted: "⏹ 已终止",
        failed: "❌ 执行失败"
    }[String(status || "running")] || "⏳ 执行中";
    let content = `**${statusText}**\n\n已用时：${formatElapsedHms(elapsedSeconds)}`;
    if (detail) {
        content += `\n\n${detail}`;
    }
    const elements = [
        { tag: "div", text: { tag: "lark_md", content } }
    ];
    if (latestOutput) {
        const snippet = latestOutput.length > 800 ? latestOutput.slice(-800) : latestOutput;
        elements.push({ tag: "hr" });
        elements.push({ tag: "div", text: { tag: "plain_text", content: `最近输出片段：\n${snippet}` } });
    }
    const actions = [];
    if (status === "running") {
        actions.push({ tag: "button", type: "danger", text: { tag: "plain_text", content: "⏹ 中止对话" }, value: { action: "abort_task" } });
        actions.push({ tag: "button", type: "default", text: { tag: "plain_text", content: "🛑 终止并新建会话" }, value: { action: "abort_and_new_session" } });
    }
    else if (status === "failed") {
        actions.push({ tag: "button", type: "danger", text: { tag: "plain_text", content: "🛑 终止并新建会话" }, value: { action: "abort_and_new_session" } });
        actions.push({ tag: "button", type: "default", text: { tag: "plain_text", content: "🆕 创建新会话" }, value: { action: "nav_new_session" } });
    }
    else if (status === "aborted") {
        actions.push({ tag: "button", type: "primary", text: { tag: "plain_text", content: "🆕 创建新会话" }, value: { action: "nav_new_session" } });
        actions.push({ tag: "button", type: "default", text: { tag: "plain_text", content: "🧭 选择旧会话" }, value: { action: "nav_sessions" } });
    }
    if (actions.length > 0) {
        elements.push({ tag: "hr" });
        elements.push({ tag: "action", actions });
    }
    return {
        config: { wide_screen_mode: true },
        elements
    };
}
