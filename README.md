# claude-mods-games

用 Claude Mods 做的小遊戲合集。Claude 在想、在跑測試的時候，輸入框上方就是你的遊戲桌；牌局全在本機跑，不消耗 token，也不佔用你跟 Claude 的對話。

## 需求

Claude Code 2.1.288 以上（Claude Mods 於 2.1.287 推出，2.1.288 修正了 mod 按鈕與輸入框上方顯示的問題）。用 `claude --version` 確認，`claude update` 更新。

## 安裝

先加入 marketplace（只需要一次）。在 Claude Code 裡輸入：

```
/plugin marketplace add IanYHChu/claude-mods-games
```

或在終端機：

```sh
claude plugin marketplace add IanYHChu/claude-mods-games
```

再安裝想玩的遊戲，例如：

```sh
claude plugin install mah-jong@claude-mods-games
```

裝好後開一個新的 session，遊戲就會出現在輸入框上方。

## 遊戲

| 遊戲 | 說明 | 安裝 |
|---|---|---|
| [mah-jong](https://github.com/IanYHChu/mah-jong) | 台灣 16 張麻將，跟三家電腦對打，會算台算錢 | `claude plugin install mah-jong@claude-mods-games` |
| [code-quest](https://github.com/IanYHChu/code-quest-cli) | 裝備驅動的 roguelike，Claude 讀到的程式碼壞味道會變成怪物，Claude 的工具呼叫推進冒險 | `claude plugin install code-quest@claude-mods-games` |

## 更新

```sh
claude plugin marketplace update claude-mods-games
```

## 授權

MIT
