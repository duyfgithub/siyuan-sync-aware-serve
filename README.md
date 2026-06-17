## 程序介绍 
> 自部署思源笔记同步感知节点

## 使用教程
> 下载到服务器上，然后在根目录运行`npm i`，然后`npm run start`，程序会运行在7777端口
> 你可以配置`nginx`转发到`7777`端口，然后就可以通过域名访问了

## 协议说明

### Push 请求
- URL: `POST /`
- Headers: `userKey`, `action: push`, `Content-Type: application/json`
- Body: `{ "syncst": 1 }`（1 = 有新变更，0 = 正常）

### Pull 请求
- URL: `POST /`
- Headers: `userKey`, `action: pull`, `Content-Type: application/json`
- Body: `{}`
- Response: `{ "userKey": "...", "syncst": 0|1 }`

## 修改记录

### 2026-06-17 duyfgithub
- 新增"纯 repoKey 模式"支持：使用 `siyuan.config.repo.key` 作为 userKey，确保同一仓库的所有设备共享相同的 userKey
- 新增"appId|repoKey 模式"兼容：保留旧版脚本的 `appId|repoKey` 格式的设备兼容
- 新增跨设备感知：通过 userAgent 区分设备，避免本机 pull 时消费自己 push 的消息
- 优化数据清理：syncst=0 的条目在下次 pull 时自动删除
- 新增 GET / 健康检查接口
- 新增 `data.json` 到 .gitignore

## 配套客户端脚本

客户端使用 `siyuanjs_fixed.js`，需要：
1. 思源笔记 → 设置 → 代码片段
2. 把脚本内容粘贴进去并启用
3. 重启思源笔记