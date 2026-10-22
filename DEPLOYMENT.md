# 部署与交付说明

本版本已改为独立账号 + 网页/PWA。没有公司服务器和正式域名时，先在本机运行；不要把 `127.0.0.1` 链接发给员工。只有部署、配置 HTTPS 并通过国内员工所在网络的实测后，才把正式网址分发给全员。

## 一、本机体验

安装 Node.js 24 或更高版本，进入解压目录：

```sh
npm run setup
npm start
```

默认访问网址 `http://127.0.0.1:3000`。配置步骤会让你在终端亲自输入管理员账号、密码；不会在聊天或命令参数里填写密码。初始化只运行一次，不覆盖已有配置。全新数据库为空，由管理员创建员工和项目。

`config/runtime.json` 只含加盐密码哈希，不含明文密码，但仍属敏感配置，请保留为当前用户可读。初始管理员哈希只用于首次建库；编辑这个字段不能重置已有账号。管理员在平台内给员工设置的临时密码，必须由员工首次登录时更换。

## 二、正式服务器：Docker + HTTPS

准备能够被员工正常访问的服务器和已指向该服务器的正式域名，使用支持 Compose v2 的 Docker。部署前确认域名、网络、证书和所选服务商的接入要求；此包不替你购买服务器或完成域名手续。

在服务器解压目录运行。下面的路径与服务文件均已随包提供：

```sh
docker build -t dinfon-work:local .
docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD:/app" -w /app dinfon-work:local node scripts/setup-local.mjs --docker
```

Docker 初始化必须填写正式 HTTPS 域名，例如 `https://work.example.com`，使用默认 443 端口。示例域名需换成你自己的，不可照抄。该步骤保存本机 `config/runtime.json` 和 `config/deploy.env`；后者记录域名及容器运行 UID/GID。若先前做过本机体验，请在新解压目录执行正式初始化，不要用本机 HTTP 配置直接启动正式容器。

```sh
docker compose --env-file config/deploy.env -f deploy/compose.yaml up -d --build
docker compose --env-file config/deploy.env -f deploy/compose.yaml ps
```

Caddy 监听 80/443 并管理 HTTPS 证书，平台服务在容器内部的 3000 端口。不要把应用 3000 端口直接发布到公网。`TRUST_PROXY=true` 仅用于该可信代理路径；Caddy 覆盖客户端传来的 `X-Real-IP`，为登录限流提供来源。若改成其他代理，须等价处理，不可直接信任公网客户端传来的转发头。

`data/` 存放 SQLite 数据，`config/` 为只读运行配置。应用使用宿主配置的 UID/GID，无需在容器里安装 npm 依赖。镜像、HTTPS 和国内网络尚需在实际服务器验证；本机接口测试不能代替该步骤。

## 三、非 Docker 部署

也可在服务器上运行 Node.js 24，前置 HTTPS 反向代理和进程管理服务：

1. `npm run setup` 填入正式 HTTPS 域名，服务保持监听 `127.0.0.1:3000`。
2. 反向代理终止 HTTPS，把该域名请求转发到 `127.0.0.1:3000`，保留原 Host。
3. 使用服务管理器以专用非 root 用户运行 `node server/standalone.mjs`，工作目录为本项目。
4. 如启用 `TRUST_PROXY`，只让可信代理访问服务，并覆盖 `X-Real-IP`；否则保持默认关闭。

配置的 `SITE_ORIGIN` 必须与员工实际访问的协议、域名、端口一致。服务拒绝错误 Host 和跨站写请求。不要用静态文件服务器直接发布 `public/`，因为账号和权限依赖服务端。

## 四、开通员工与手机使用

管理员登录后进入「账号管理」，创建账号、初始密码、角色并勾选参与项目。关联已有成员可保留其任务归属。员工首次登录设置自己的密码后即可查看参与项目。分配项目和任务负责人是不同操作：移出项目只撤销访问，不会自动改派任务。

给员工发送正式网址，使用公司可信渠道交付临时密码。无需 ChatGPT、App Store、邮箱邀请或境外验证码服务。此版本支持独立密码登录，尚未接入短信或企业微信登录。

手机打开正式 HTTPS 网址后按页面「手机桌面版」说明操作。iPhone 使用 Safari 分享菜单添加到主屏幕；安卓安装项取决于浏览器。PWA 与网页访问同一数据库；不提供 APK/IPA，不支持离线处理任务。

## 五、备份与恢复

普通 Node 部署运行：

```sh
npm run backup
```

该命令使用 SQLite 在线备份接口生成一致性数据库快照，包括账号、会话和所有业务记录。不能在服务写入时仅复制主 `.sqlite` 文件而忽略 WAL。

Docker 部署可挂载专用备份目录运行同一脚本：

```sh
mkdir -p backups
docker compose --env-file config/deploy.env -f deploy/compose.yaml run --rm --no-deps -v "$PWD/backups:/app/backups" app node scripts/backup.mjs
```

备份目录与配置文件应另存至有访问控制的公司存储。此包提供备份命令，尚未替你设定自动备份任务。

恢复时先停止应用，将原 `data/` 整个目录另存保留；新建可写 `data/`，把选定快照复制为 `data/dinfon.sqlite`，然后启动并检查项目和账号。不要把旧 `-wal`/`-shm` 文件混入恢复后的数据库。旧会话可能随快照恢复，请按公司操作要求重置相关账号；业务 JSON 导出不能替代此完整备份。

## 六、管理员忘记密码

仅服务器操作员在服务器终端执行：

```sh
npm run admin:recover
```

输入现有有效管理员账号和新临时密码，脚本只重置该管理员、清除其旧登录并记录操作，首次登录要求再次改密。没有公开找回链接或免验证重置接口。

Docker 使用：

```sh
docker compose --env-file config/deploy.env -f deploy/compose.yaml run --rm --no-deps -it app node scripts/manage-admin.mjs recover
```

## 七、旧版数据

此次没有从原 chatgpt.site 的 D1 或旧浏览器自动复制公司数据。原站点继续保留；新的部署包不会将旧数据、密码、个人配置或预览测试账号带入正式环境。

如果后续把旧版完整数据库导出并迁入兼容 SQLite，先完整备份，再配置新的运行文件，执行 `npm run admin:migrate`，显式选择一个旧管理员 ID、独立登录名与新密码。该命令仅在还没有任何独立账号时允许迁移，不根据邮箱自动接管旧身份。业务记录、成员 ID 和任务归属保留。

旧员工账号不能仅凭原邮箱直接登录。当前迁移工具只处理首位管理员，其余旧账号须由部署人员逐个完成凭据迁移后验收；不要删除旧成员或重新分配用户 ID 来冒充迁移。普通新员工可以直接通过账号管理开通。此项旧账号批量迁移尚未实现。

## 八、上线验收

在正式环境至少完成：管理员独立登录；两个员工跨账号隔离；账号开通及项目分配；首次改密；停用后旧登录失效；节点审批与成果提交；备份恢复演练；员工真实国内网络访问；iPhone/安卓添加桌面、键盘和断网重连。

自动化覆盖不等同于真实员工已经验收。本轮无正式域名/服务器，也未进行手机实机安装。
