# 前端修改紀錄

> 前端（`frontend/`）的修改都要留一筆。格式見 [AGENT.md](../../AGENT.md) §10。

---

## 紀錄格式

```markdown
## YYYY-MM-DD｜一句話標題

**項目**：架構圖 / 詳情面板 / 紀錄頁 / 錯誤頁 / SSE / 其他
**內容**：改了什麼
**修改**：檔案與位置
**驗證**：對應的 Gherkin 場景 / Vitest 測試
```

---

<!-- 新的紀錄加在這行下面，最新的放最上面 -->

## 2026-09-18｜詳情面板的狀態時長顯示為「已維持 15 分鐘前」

**項目**：詳情面板
**內容**：`agoText()` 回傳「15 分鐘前」，模板又寫「已維持 {{ agoText }}」，組合出「已維持 15 分鐘前」。拆成 `durationText()`（時長）與 `agoText()`（距今多久）兩個函式，狀態列改用前者。
**修改**：[frontend/src/components/ServiceDetailPanel.vue](../../frontend/src/components/ServiceDetailPanel.vue)
**驗證**：面板顯示「已維持 15 分鐘」，最後心跳欄位仍顯示「10 秒前」
