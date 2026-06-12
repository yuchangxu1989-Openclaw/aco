# ACO Product Requirements

唯一真相源在飞书，本地不保留 spec 详情。

## 飞书文档

- **Token**: GRJ8dh5IPoNqeLx1Y8CcbONInWd
- **读取命令**: `lark-cli docs +fetch --doc GRJ8dh5IPoNqeLx1Y8CcbONInWd`
- **在线地址**: https://phoenix-yu.feishu.cn/docx/GRJ8dh5IPoNqeLx1Y8CcbONInWd

## 子 Agent 操作规范

- 读 spec：`lark-cli docs +fetch --doc GRJ8dh5IPoNqeLx1Y8CcbONInWd`
- 改 spec：`lark-cli docs +update --doc GRJ8dh5IPoNqeLx1Y8CcbONInWd --mode overwrite --markdown "$(cat file.md)" --as bot`
- 禁止在本地写 spec 内容然后"同步"到飞书
