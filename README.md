# Typecho-CF

[English](README.en.md)

基于 [Typecho](https://typecho.org) 完整重写的现代博客系统，运行在 **Astro + Cloudflare Workers + D1** 之上。保留 Typecho 数据库表结构，支持从 PHP 版 Typecho 直接迁移数据。

---

## 功能特性

**前台**：文章列表 / 分类 / 标签 / 作者 / 搜索归档（FTS5 全文检索，短词自动回退 LIKE）、嵌套评论（Gravatar 头像）、RSS 2.0 / Atom 1.0 / RSS 1.0、文章密码保护、响应式默认主题

**管理后台**：文章 & 页面编辑管理、评论审核、媒体管理（R2 拖放上传）、用户管理（5 种角色）、主题切换、插件管理（启用/禁用/配置）、全站设置、安装向导

**系统**：主题系统（npm 包分发）、插件系统（30+ 已接入 Hook，支持懒加载）、PHP 版 Typecho 数据迁移工具、PBKDF2-SHA256 认证、CSRF 防护、安全响应头、请求体限额、R2 上传类型校验

---

## 安装部署

### 前置要求

- Node.js **22.12+**
- [pnpm](https://pnpm.io)（`npm install -g pnpm`）
- Cloudflare 帐号（仅部署到 Cloudflare 时需要）

### 本地开发

```bash
git clone https://github.com/eslizn/typecho-cf.git
cd typecho-cf
pnpm install

# 生成本地 Wrangler 配置（本地模拟 D1/R2 时可保留示例中的占位 database_id）
cp wrangler.toml.example wrangler.toml

# 可选：保护本地安装窗口（写入后重启 dev）
# echo 'INSTALL_TOKEN=your-secret' >> .dev.vars

pnpm run dev
```

1. 打开 http://localhost:4321 ，未安装时会跳转到 `/install`
2. 填写安装表单：站点名称 / 描述、管理员用户名、密码（至少 12 位）、邮箱；若配置了 `INSTALL_TOKEN`，还需填写安装令牌
3. 提交后完成建表与管理员创建，随后可访问 `/admin` 登录

`wrangler.toml` 已加入 `.gitignore`，勿提交真实 `database_id` 或密钥。

### 部署到 Cloudflare

**1. 登录 Cloudflare**

```bash
pnpm exec wrangler login
```

**2. 创建资源**

```bash
pnpm exec wrangler d1 create typecho-cf-db
pnpm exec wrangler r2 bucket create typecho-cf-uploads
```

记下命令输出的 D1 `database_id`。

**3. 配置 `wrangler.toml`**

```bash
cp wrangler.toml.example wrangler.toml
```

将 `database_id` 替换为上一步的真实 ID：

```toml
[[d1_databases]]
binding = "DB"
database_name = "typecho-cf-db"
database_id = "替换为实际的 ID"
```

R2 桶名默认 `typecho-cf-uploads`，若创建时使用了其他名称，同步修改 `[[r2_buckets]].bucket_name`。

**4. 设置安装令牌（推荐）**

```bash
pnpm exec wrangler secret put INSTALL_TOKEN
```

未设置时仍可安装，但任意先访问 `/install` 的人都能注册首个管理员。设置后，安装表单必须填写同一令牌。

**5. 构建并部署**

```bash
pnpm run deploy
```

**6. 完成安装**

访问 Worker URL → `/install` → 填写站点与管理员信息（及 `INSTALL_TOKEN`）→ 登录 `/admin`。

---

## 命令参考

| 命令 | 说明 |
|------|------|
| `pnpm run dev` | 本地开发服务器 |
| `pnpm run build` | 生产构建 |
| `pnpm run deploy` | 构建 + 部署到 Cloudflare Workers |
| `pnpm run lint` | 类型感知静态检查（含浮空 Promise） |
| `pnpm run types:workers` | 按 Wrangler 配置生成 Worker 绑定与运行时类型 |
| `pnpm run typecheck` | 生成 Workers / Astro 类型并运行 TypeScript 检查 |
| `pnpm run test` | 运行所有测试 |
| `pnpm run test:watch` | 监听模式运行测试 |
| `pnpm run test:coverage` | 生成覆盖率报告 |
| `pnpm run db:generate` | 生成 Drizzle 数据库迁移 |
| `pnpm run db:studio` | 启动 Drizzle Studio |
| `pnpm run db:migrate:local` | 迁移 PHP Typecho 数据到本地 |
| `pnpm run db:migrate:cloudflare` | 迁移 PHP Typecho 数据到 Cloudflare D1 |
| `pnpm run db:migrate:dry-run` | 预览迁移（不写入） |
| `pnpm run reset-password` | 重置用户密码（本地） |
| `pnpm run reset-password:cloudflare` | 重置用户密码（Cloudflare） |

修改 `wrangler.toml` / `wrangler.toml.example` 中的绑定后，运行 `pnpm run types:workers`。生成的 `worker-configuration.d.ts` 仅供本地与 CI 使用，不纳入版本控制；干净检出且缺少 `wrangler.toml` 时，类型生成会自动回退到 `wrangler.toml.example`。

示例配置默认持久化可搜索 Workers Logs，并以约 1% 采样率记录调用链；生产环境可按流量与成本调整。密钥使用 `wrangler secret put`（本地可用 `.dev.vars`），不要写入已跟踪的配置文件。

---

## 从 PHP 版 Typecho 迁移

```bash
# 迁移到 Cloudflare（生产）
pnpm run db:migrate:cloudflare \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads

# 迁移到本地（开发）
pnpm run db:migrate:local \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads

# 预览（不写入）
pnpm run db:migrate:dry-run \
  --source /path/to/typecho.db \
  --uploads /path/to/usr/uploads
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--source`, `-s` | 源 SQLite 数据库路径 | （必填） |
| `--uploads`, `-u` | 源 `usr/uploads/` 目录；省略时只迁移数据库 | （可选） |
| `--prefix` | 源表前缀 | `typecho_` |
| `--dry-run`, `-n` | 预览模式 | `false` |
| `--site-url` | 新站点 URL（用于重写附件 URL） | — |
| `--d1-name` | D1 数据库名 | `typecho-cf-db` |
| `--r2-bucket` | R2 存储桶名 | `typecho-cf-uploads` |

密码哈希算法不兼容（PHP phpass → PBKDF2-SHA256），迁移后需重置密码：

```bash
pnpm run reset-password              # 本地
pnpm run reset-password:cloudflare   # Cloudflare
```

---

## 插件开发

参考 [插件开发规范](src/plugins/README.md)。

邮件发送没有内置 SMTP/API 适配器。忘记密码与评论通知仅在启用邮件设置且已安装实现 `mail:send` Hook 的插件后才会投递；未安装适配器时安全降级为未发送。

---

## 主题开发

参考 [主题开发规范](src/themes/README.md)。

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 框架 | [Astro](https://astro.build) 7.x (SSR) |
| 适配器 | [@astrojs/cloudflare](https://docs.astro.build/en/guides/integrations-guide/cloudflare/) 14.x |
| 运行时 | [Cloudflare Workers](https://workers.cloudflare.com) |
| 数据库 | [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) |
| ORM | [Drizzle ORM](https://orm.drizzle.team) 0.45.x |
| 文件存储 | [Cloudflare R2](https://developers.cloudflare.com/r2/) |
| 语言 | TypeScript 7.x |
| 测试 | [Vitest](https://vitest.dev) 4.x |
| 包管理 | pnpm |

---

## 安全与测试约束

- 管理 API 必须通过 `requireAdminAction()` 做登录、权限与 CSRF 校验；重定向回后台页面必须使用同源且仅限 `/admin` 路径的安全回跳。
- 评论来源与评论提交后的回跳只按 URL `origin` 判定可信来源，禁止用字符串前缀或仅 host 比较。
- 前台、后台、插件路由和缓存命中的响应都由中间件补齐基础安全响应头。
- 新增功能和 bug 修复必须补对应回归测试，并同时通过 `pnpm run test` 与 `pnpm run typecheck`。

---

## 与 PHP 版 Typecho 兼容性

| 方面 | 状态 |
|------|------|
| 数据库结构 | ✅ 7 张核心表兼容；运行时会幂等补齐登录限速和密码重置辅助表 |
| 默认主题样式 | ✅ CSS & HTML 结构保持一致 |
| URL 结构 | ✅ 路由规则与 Typecho 默认配置一致 |
| 密码哈希 | ⚠️ 迁移后需重置密码（算法不同） |
| PHP 主题 / 插件 | ❌ 需按新格式重新封装（TypeScript / npm 包） |

---

## 许可证

MIT

---

## 开发指南

- 插件开发规范：[src/plugins/README.md](src/plugins/README.md)
- 主题开发规范：[src/themes/README.md](src/themes/README.md)
- AI Agent 开发规范：[AGENTS.md](AGENTS.md)
