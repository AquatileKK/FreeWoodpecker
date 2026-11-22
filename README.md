# 校园电脑维修报修系统

一个面向校园的电脑维修在线报修网站：学生免注册提交报修单，站长在后台处理订单。
这是一个个人学习/练手项目，使用 **纯 HTML/CSS/JavaScript + Netlify + Netlify Functions + Supabase**，没有任何前端框架和第三方 npm 依赖。

> ⚠️ 本项目会收集姓名、手机号、宿舍等个人信息。如果你要基于它真实运营，请先确认所在地区的隐私与数据合规要求
> （例如数据存放地点、保存期限、学校规定），并把 `public/privacy.html` 改成与你实际情况一致的内容。

## 功能

- 学生端：免注册提交报修（姓名、手机号、楼栋房间、维修方式、预约时间、故障描述、最多 3 张图片）
- 提交后生成订单号和**取消链接**（随机令牌，数据库只保存 SHA-256 哈希），学生凭链接取消订单
- 管理后台：管理员登录、订单列表（筛选/搜索/分页）、详情与图片、接单/拒单/开始维修/完成/取消、报价与实收、备注、状态日志
- PWA：可添加到手机桌面，断网显示提示页
- 不含在线支付：现场检测、当面报价、当面结算

## 安全设计

- 数据库开启 RLS 且不创建任何策略，浏览器端角色权限全部收回；所有数据库访问只经过 Netlify Functions
- 管理员密钥（Supabase secret key）只存在服务端环境变量，不会出现在前端代码里
- 后台使用 Supabase Auth 密码登录，令牌只放在 HttpOnly + SameSite=Strict 的 Cookie 里；每个请求服务端都会校验，并要求邮箱在 `ADMIN_EMAILS` 白名单内
- 图片：浏览器端重新编码（去除 EXIF）、服务端按文件头校验格式和大小、存放在私有存储桶，只能通过已登录管理员的接口读取
- 取消订单使用原子条件更新，避免与管理员操作互相覆盖；同一手机号每小时最多 3 单；蜜罐字段挡简单机器人
- 后台页面带严格的内容安全策略（CSP）；所有展示内容用 `textContent` 写入

## 目录结构

```
public/                静态页面（报修页、取消页、隐私页、后台页、PWA 文件）
netlify/functions/     Netlify Functions（提交订单、取消、后台接口、健康检查）
netlify/lib/           公共代码（校验、令牌、Supabase 访问、后台鉴权）
supabase/migrations/   数据库脚本，按编号顺序执行
tests/                 自动测试（使用本地假 Supabase 服务器与虚构数据）
netlify.toml           部署与响应头配置
```

## 部署步骤

1. 在 [Supabase](https://supabase.com) 新建项目；在 SQL Editor 中**按顺序**执行 `supabase/migrations/` 里的 `0001`、`0002`、`0003`。
2. 在 Supabase Authentication 中手动创建一个管理员用户，并**关闭公开注册**。
3. 复制 `.env.example` 为 `.env`，填写：
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`（Secret key，绝不能公开）
   - `SUPABASE_ANON_KEY`（Publishable key）
   - `ADMIN_EMAILS`（管理员邮箱，多个用英文逗号分隔）
4. 本地运行：`npm install -g netlify-cli`，然后 `netlify dev`，打开 http://localhost:8888 。
5. 部署：在 Netlify 创建站点并把上面 4 个变量填到 Site configuration → Environment variables，然后 `netlify deploy --prod`，或把仓库连接到 Netlify 自动部署（无需构建命令，发布目录 `public`）。

## 测试

```
npm test
```

需要 Node.js 20+。测试不会连接真实 Supabase，全部使用虚构数据。

## 许可证

[MIT](LICENSE)
