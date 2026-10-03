# SMTP Mailer

基于 [`@workermailer/smtp`](https://github.com/worker-mailer/smtp)（Cloudflare TCP Sockets）的 SMTP 邮件发送适配器。

> 本插件实现核心的 `mail:send` filter hook。启用后，站点的评论通知、评论回复提醒与密码重置邮件才会真正投递——没有适配器时这些邮件会安全降级为「未发送」。

## 功能

- 实现 `mail:send` 适配器：评论通知（文章作者）、评论回复提醒（父评论作者）、密码重置邮件自动生效
- 支持 SMTP 认证：`PLAIN` / `LOGIN` / `CRAM-MD5`
- 支持 SSL/TLS（465 端口直连）与 STARTTLS（587 端口升级）
- 插件设置页（`/admin/plugin/smtp-mailer`）：查看配置摘要 + 一键发送测试邮件
- 保存前校验 SMTP 配置（host / 端口 / 认证方式 / 超时）

## 安装

```bash
pnpm add typecho-plugin-smtp-mailer
pnpm run build
```

> 本仓库内置插件：在根 `package.json` 添加 `"typecho-plugin-smtp-mailer": "file:src/plugins/typecho-plugin-smtp-mailer"` 后执行 `pnpm install`。

## 配置

在后台 **插件 → SMTP Mailer → 设置** 中填写：

| 字段 | 说明 |
|------|------|
| SMTP 服务器 | 如 `smtp.qq.com` / `smtp.163.com` / `smtp.gmail.com` |
| 端口 | `465`（SSL/TLS）或 `587`（STARTTLS）。Cloudflare Workers 不支持 25 端口 |
| SSL/TLS 加密 | 465 端口直连 TLS 时启用 |
| STARTTLS 升级 | 587 端口先明文后升级 TLS 时启用 |
| 用户名 | 一般为完整邮箱地址；留空表示匿名发送 |
| 密码 / 授权码 | QQ / 163 等需使用**授权码**（SMTP 专用密码），不是登录密码 |
| 认证方式 | `PLAIN` / `LOGIN` / `CRAM-MD5` |
| 连接 / 响应超时 | 毫秒，默认 30000 |

发件人（From）使用**常规设置**中的「发件邮箱 / 发件人名称」（`mailFrom` / `mailFromName`）。

## 启用评论邮件通知

1. 启用插件并填写 SMTP 配置
2. **常规设置** → 勾选「启用邮件发送」，填写发件邮箱
3. **讨论设置** → 勾选「有新评论时发送邮件通知」；如需要，同时勾选「包含评论回复通知」
4. 在插件设置页点击「发送测试邮件」验证配置

此后，评论通过审核时系统会自动：
- 给**文章作者**发送新评论通知；
- 给**父评论作者**发送回复提醒（当被回复者留下邮箱时）。

## 常见问题

- **发件失败 / 认证失败**：确认使用 SMTP 授权码而非登录密码；部分服务商要求发件邮箱与 SMTP 用户名一致（`mailFrom` 需填该邮箱）。
- **连接超时**：确认端口为 465 或 587；某些主机商（如 Gmail）需要开启「低安全性应用访问」或使用应用专用密码。
- **评论后没有邮件**：依次检查 插件已启用 → 常规设置「启用邮件发送」→ 讨论设置「有新评论时发送邮件通知」→ 测试邮件是否成功。
- **发送到 587 失败**：若服务商强制 STARTTLS，将「STARTTLS 升级」设为启用、端口设为 587。

## 开发

```sh
npx vitest run src/plugins/typecho-plugin-smtp-mailer/index.test.ts
```

## Hook 一览

| Hook | 类型 | 说明 |
|------|------|------|
| `mail:send` | filter | SMTP 投递适配器；首个返回 `sent: true` 的插件完成投递 |
| `plugin:config:beforeSave` | filter | 保存前校验 / 规范化 SMTP 配置 |
| `admin:page` | filter | `/admin/plugin/smtp-mailer` 设置页（配置摘要 + 测试发送） |
| `admin:footer` | filter | 后台导航注入菜单项 |
| `plugin:typecho-plugin-smtp-mailer:action:auth` | filter | 声明 `test-send` 动作最低角色为管理员 |
| `plugin:typecho-plugin-smtp-mailer:action` | filter | 执行「发送测试邮件」动作 |
