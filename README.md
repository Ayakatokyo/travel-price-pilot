# Travel Price Pilot：个人旅行报价采集

独立的个人项目，以 **OpenCLI 2.0.2** 为固定依赖，平台适配和采集逻辑保存在本仓库。代码仓库：[Ayakatokyo/travel-price-pilot](https://github.com/Ayakatokyo/travel-price-pilot)。

当前可以采集下列平台的部分真实展示数据并留档。同一酒店、房型或航班产品的条件匹配尚未完成，因此还不是完整的自动比价产品。

采集范围调整（2026-11-01）：按用户决定，停止去哪儿、同程的后续接入、查询与重试，酒店和机票均不再主动采集，也不再要求用户为这两家登录。已有机票数据、失败记录与适配器保留归档；只有用户重新提出接入时才恢复。后续工作聚焦其余平台。

`trip.example.json` 的 `excluded_providers` 默认排除这两家；本地 `trip.json` 存在时优先使用其配置。项目采集入口会在启动浏览器前拒绝停用平台的查询；结果索引把其历史记录单独展示，不计入当前范围的报价数量。个人行程 `trip.json` 不进入 Git。

## 为什么采用独立项目

行程、报价结构、酒店匹配、展示与历史记录属于这个项目；浏览器连接和上游平台能力由 OpenCLI 提供。需要修正的行为放在本项目 `adapters/travel-price/` 中，复用固定版本的上游代码，不修改 `node_modules`，也不需要现在维护整个 OpenCLI fork。

项目扩展通过 Node 的 `--import` 加载，使用 OpenCLI 的命令注册接口。当前为项目内使用；这些扩展导入了固定版本包内的适配器和部分非稳定接口，因此升级 OpenCLI 时必须重新验收。参考：[OpenCLI 扩展方式](https://github.com/jackwener/opencli/blob/97dc0cd5214b9602bcda78d7422f231ee8a803e9/docs/guide/extending-opencli.md)。

## 本轮真实采集结果

实测日期：2026-10-31。本地采集后生成结果索引 `local/RESULTS.md`；原始结果及浏览器会话仅保存在本机，不随公开仓库分发。以下数量是本轮实际保存的展示记录，不代表完整库存或已经去重的候选项。表格和索引中去哪儿、同程的状态仅保留历史实测结果，不表示仍在接入范围内。

| 平台 | 查询 | 本轮取得 | 状态 |
| --- | --- | --- | --- |
| Booking | 首尔，2027-01-08 至 01-10，2 成人、1 间房，USD | 25 条酒店展示报价，房型摘要、税费提示 | 已实测；浏览器登录由用户完成 |
| Trip.com | 相同城市、日期，USD | 12 条酒店展示报价，房型、床型、详细全程金额；记录房间资料中的人数和间数 | 已实测；其中 1 条房间资料字段为 4 成人，标记为条件不符 |
| 携程机票 | 上海 SHA → 首尔 SEL，2027-01-08，2 成人 | 6 条当前加载的航班展示起价，CNY | 已实测；接口捕获超时后读取页面卡片，非完整航班列表 |
| 携程酒店 | 首尔，相同酒店测试日期 | 5 条酒店基础资料，0 条数字报价 | 页面提示登录查看会员价；当前酒店适配器未传两人条件，页面实际为 1 成人、1 间 |
| 携程 / Trip.com 目的地搜索 | 首尔 | 城市、机场、部分酒店基础资料 | 已实测；目的地资料不计入报价数量 |
| Agoda | 首尔，2027-01-08 至 01-10，2 成人、1 间，USD | 10 条酒店每晚展示价 | 已核对页面日期、人数及实际币种；没有把每晚价乘两晚冒充全程额 |
| Expedia 酒店 | 相同首尔条件，USD | 3 条当前加载的酒店全程展示价 | 页面注明包含税费；仅取得 3 条，未声称覆盖完整列表 |
| 飞猪酒店 | 相同首尔条件，CNY | 10 家资料，其中 4 条数字起价 | 保留“暂无报价”；起价的计价周期、房型和全部费用未验证 |
| Rakuten Travel | 大阪，2027-01-12 至 01-14，2 成人、1 间，USD | 10 条房间全程起价 | 保留 Seasonal Sale Coupon 等优惠条件；税费未知 |
| Jalan | 相同大阪条件，JPY | 10 条具体房型的全程展示价 | 保留原始日元金额；页面的 USD 换算仅作参考，不作为报价币种 |
| 同程机票 | 上海 SHA → 首尔 SEL，2027-01-08，2 成人 | 10 条当前加载的航班展示价 | 登录状态已生效，页面两人条件已核对；“含税总价”的按人/整单口径仍未确认 |
| 飞猪机票 | 相同城市、日期 | 10 条当前加载的航班展示价 | 当前网页没有成人数选择，不能声称两人条件已执行 |
| Expedia 机票 | 上海全部机场 SHA → 首尔全部机场 SEL，2027-01-08，2 成人、经济舱、单程 | 10 条 USD 单程每人起价 | 已核对页面人数和日期；采用当前优惠价而非划线原价，未取得航班号与最终费用 |
| 去哪儿酒店 | 相同首尔酒店条件 | 0 条报价 | 实际查询曾返回 HTTP 204 空响应、HTTP 403；不把页面“0 家酒店”当作无房 |
| 同程酒店 | 相同首尔酒店条件 | 0 条报价 | 电脑版返回业务错误 `-99`；官方手机网页核对两人及日期后明确提示“您的账号异常，请稍后重新尝试” |
| 去哪儿机票 | 官方触屏版，上海全部机场 → 首尔全部机场，2027-01-08 | 10 条人均含税展示价，CNY 推定 | 页面实际发出的查询为 2 成人、0 儿童；婴儿数未返回，保持未知。页面同时显示 11 月 4 日起停服提示（未注明年份） |

新增平台本轮合计取得 **37 条酒店数字展示价、40 条机票数字展示价**。原有 Booking、Trip.com 和携程数据另行保留。未列出的“平台 × 产品”组合尚未验证。

排除去哪儿和同程后，本次新增范围保留 **Agoda、Expedia、飞猪、Rakuten Travel、Jalan** 五个平台，合计 **37 条酒店数字展示价、20 条机票数字展示价**。包括此前 Booking、Trip.com 和携程已采集结果在内，当前范围各组最新留档合计 **74 条酒店数字展示价、26 条机票数字展示价**；携程酒店仍只有基础资料，没有数字报价。以上都是保存时点的展示记录，不是实时可支付价格。

文档中的城市、日期和人数是接入验证参数，**不是旅行行程建议**。使用时通过命令行指定自己的查询条件；个人行程可保存在已被 Git 忽略的 `trip.json`。

此前 FlyAI 体验模式验证保留在 `probe.py` 和 `local/`：酒店返回遮挡价格，机票返回业务错误，均不算可比报价。

## 数据与边界

每次查询新建 `local/runs/<时间>-<平台>-<类型>-<编号>/`，不会覆盖旧观察：

- `raw.sanitized.json`：OpenCLI 返回数据，去除账户字段、邮箱和链接中的会话参数。
- `result.json`：规范化结果、原始查询条件、时间、页面状态、采集方式与版本依据。
- `quotes.csv`：便于查看的报价清单。
- `report.md`：该次查询的中文说明。

金额保留原币种和十进制字符串，不自动换汇，不把机票起价乘二当作两人可支付总价。酒店每晚展示价、页面全程金额、税费提示分别保存。Trip.com 的详细总额优先于页面取整展示，例如详细金额 `346.82` 与取整金额 `347` 不混用。

`observed_conditions_match` 为 `true` / `false` / `null`，分别表示已核对一致、实际不一致、信息不足。请求参数不是平台已执行条件的证据。飞猪机票的成人数保持未知；同程、飞猪、去哪儿机票的 CNY 当前根据中文网页“元/¥”推定，并标记 `currency_verified=false`，没有伪造明确的 ISO 币种来源。

Expedia 机票查询已经核对 2 成人、0 儿童、0 婴儿；列表明确显示 `One way per traveler`，因此 `price_basis=one_way_per_traveler_starting_fare`。当前价与划线原价分开辨认，原文保留在 `price_raw`；USD 来自页面币种选择器。航班号未在当前列表提供，保留为空；机场、起降时间和航空公司在 `result.json` 中，不凭航司名称合并记录。

去哪儿电脑版门户的停服提示不代表其触屏入口已无法查询。本轮通过[官方触屏表单](https://touch.qunar.com/h5/flight/)设置人数和日期后取得报价，并验证直达结果页可复跑。采集仅读取页面卡片和页面自然发出请求的城市、日期、人数等字段；不保存身份字段或解码平台的不透明响应。没有选择具体舱位，当前列表也未提供航班号；人均含税展示金额没有乘二。触屏结果页自身的 11 月 4 日起停服提示已保存在 JSON 和报告中，后续能否继续使用需重新验证。

`comparable=false` 和 `comparable_quote_count=0` 是有意保留的状态：同一物业、具体房型/床型、餐食、取消截止时间、支付条件、全部必付费用尚未完成跨平台核对。酒店名称相似不自动认定为同一家；最终支付金额也尚未验证。

携程机票使用 `collection_method=rendered_cards_after_timeout` 和 `exhaustive=false` 标识降级来源，只读取已加载的卡片；不会把网络超时掩盖成完整搜索成功。部分卡片没有航班号或舱位，原样保留缺失。

失败、需要登录、需要人工验证、搜索跳转、空响应和无数字价格分别记录；失败或空响应不证明该日期无房/无票。

## 安装与运行

需要 Python 3.10+、符合包要求的 Node.js（本机验证为 25.9.0）及 Chrome。优先使用本机已有的 Chrome for Testing，否则使用系统 Chrome。也可用 `TRAVEL_CHROME_PATH` 指定可执行文件。

```bash
git clone https://github.com/Ayakatokyo/travel-price-pilot.git
cd travel-price-pilot
npm ci --ignore-scripts
npm run browser:start

npm run collect -- destination --provider ctrip --query 首尔 --limit 5

npm run collect -- hotel --provider booking --city "Seoul, South Korea" --city-id=-716583 --check-in 2027-01-08 --check-out 2027-01-10 --adults 2 --rooms 1 --currency USD --test-window --limit 25

npm run collect -- hotel --provider trip --city-id 274 --check-in 2027-01-08 --check-out 2027-01-10 --adults 2 --rooms 1 --currency USD --test-window --limit 12

npm run collect -- flight --provider ctrip --origin SHA --destination SEL --date 2027-01-08 --adults 2 --limit 10

npm test
```

如需自定义停用平台，可复制 `trip.example.json` 为本地 `trip.json` 后修改；已有个人配置时直接编辑该文件。没有本地配置时，采集入口使用示例配置。

本轮新增的可复跑命令（后台模式保留用户正在操作的前台标签）：

```bash
TRAVEL_BACKGROUND=1 npm run collect -- hotel --provider agoda --city Seoul --city-id 14690 --check-in 2027-01-08 --check-out 2027-01-10 --adults 2 --rooms 1 --currency USD --test-window --limit 10
TRAVEL_BACKGROUND=1 npm run collect -- hotel --provider expedia --city "Seoul, South Korea" --city-id 3124 --check-in 2027-01-08 --check-out 2027-01-10 --adults 2 --rooms 1 --currency USD --test-window --limit 10
TRAVEL_BACKGROUND=1 npm run collect -- hotel --provider fliggy --city Seoul --city-id 903551 --check-in 2027-01-08 --check-out 2027-01-10 --adults 2 --rooms 1 --currency CNY --test-window --limit 10
TRAVEL_BACKGROUND=1 npm run collect -- hotel --provider rakuten --city Osaka --check-in 2027-01-12 --check-out 2027-01-14 --adults 2 --rooms 1 --currency USD --test-window --limit 10
TRAVEL_BACKGROUND=1 npm run collect -- hotel --provider jalan --city Osaka --check-in 2027-01-12 --check-out 2027-01-14 --adults 2 --rooms 1 --currency JPY --test-window --limit 10
TRAVEL_BACKGROUND=1 npm run collect -- flight --provider fliggy --origin SHA --destination SEL --date 2027-01-08 --adults 2 --limit 10
TRAVEL_BACKGROUND=1 npm run collect -- flight --provider expedia --origin SHA --destination SEL --date 2027-01-08 --adults 2 --limit 10
```

<details>
<summary>已停止接入的平台：历史命令（不再执行）</summary>

去哪儿和同程的以下命令仅作历史留档。酒店探测返回非零退出码是此前的失败状态，不是已完成的报价接入：

```bash
TRAVEL_BACKGROUND=1 npm run collect -- flight --provider tongcheng --origin SHA --destination SEL --date 2027-01-08 --adults 2 --limit 10
TRAVEL_BACKGROUND=1 npm run collect -- flight --provider qunar --origin SHA --destination SEL --date 2027-01-08 --adults 2 --limit 10
TRAVEL_BACKGROUND=1 npm run collect -- hotel --provider qunar --city Seoul --check-in 2027-01-08 --check-out 2027-01-10 --adults 2 --rooms 1 --currency CNY --test-window --limit 10
TRAVEL_BACKGROUND=1 npm run collect -- hotel --provider tongcheng --city Seoul --city-id 110019490 --check-in 2027-01-08 --check-out 2027-01-10 --adults 2 --rooms 1 --currency CNY --test-window --limit 10
```

这些探测若返回 `UNVERIFIED_RESPONSE`，表示返回结构未经验证；不能据此声称取得报价。

</details>

浏览器使用结束后可运行 `npm run browser:stop`。

首尔的携程/Trip 城市 ID `274` 来自各平台实际目的地查询；Booking 城市 ID `-716583` 来自网页搜索框选择首尔后生成的结果页。其他目的地需重新解析，不能沿用首尔 ID。

其他已解析的首尔 ID：Agoda `14690`、Expedia `3124`、飞猪 `903551`、同程 `110019490`；去哪儿使用 `i-seoul`。Rakuten、Jalan 的当前适配器只支持大阪一间房；同程、飞猪、Expedia、去哪儿机票目前只验证了上海至首尔。`--currency` 是期望值，实际结果以采集到的 `currency` / `currency_basis` 为准，部分适配器当前只读取固定币种。

Booking 的城市 ID 参数可省略，但若字符串搜索发生跳转，需要先从实际搜索表单解析 ID。携程和 Trip 的酒店命令目前未支持任意入住人数/间数传参：请求值与观测值分开保存，Trip 另有 `observed_conditions_match`，不能把参数记录当作平台已执行该条件。

项目使用 OpenCLI 自带的 **直接 CDP 连接**，专用浏览器状态保存在 `local/browser/profile/`。浏览器会话留在本机，整个 `local/`、`node_modules/`、`.vendor/` 以及个人 `trip.json` 均已被 Git 忽略。`npm run doctor` 检查的是上游 Browser Bridge 扩展；本项目走直接 CDP，因此“扩展未连接”不代表本项目浏览器不可用。

一次只运行一个采集命令。查询期间保留专用浏览器窗口；携程机票仍需要前台页面，会切换到该查询标签。新增采集支持 `TRAVEL_BACKGROUND=1`。去哪儿探测、同程酒店、Expedia 机票在后台查询期间临时启用页面活动模拟，结束时恢复，避免因后台初始化延迟而误报为空。停止浏览器不会删除登录状态。

## 代码与本轮修正

- `opencli_probe.py`：命令入口、数据标准化、脱敏和结果索引。
- `browser_session.py`、`browser_state.mjs`：项目专用浏览器与最少页面状态检查。
- `adapters/travel-price/ctrip-flight.js`：补成人数，网络超时后明确降级读取当前页面卡片。
- `adapters/travel-price/trip-hotel.js`：读取现行 SSR 酒店数据，替代上游失效的旧 DOM 选择器。
- `adapters/travel-price/booking-hotel.js`：使用解析出的目的地 ID、适配直接 CDP 的等待方式、核验页面币种、保留税费信息。
- `adapters/travel-price/{agoda,expedia,fliggy,rakuten,jalan}-hotel.js`：本轮已取得真实酒店展示数据的适配器。
- `adapters/travel-price/{qunar,tongcheng}-hotel.js`：查询与错误留档探测，报价解析尚未验证。
- `adapters/travel-price/flight-probes.js`、`fliggy-flight.js`：同程/飞猪机票展示数据，以及保留的去哪儿电脑版探测 `qunar-flight-desktop-probe`。
- `adapters/travel-price/expedia-flight.js`：从官方表单验证的单程查询、每人起价和实际人数；排除划线原价。
- `adapters/travel-price/qunar-flight.js`：官方触屏机票列表、人均含税价、页面实际发出的查询人数，以及停服提示。
- `adapters/travel-price/browser-utils.js`：查询参数验证、内容就绪判断、后台页面活动的恢复。
- `probe.py`：保留早期 FlyAI 官方接口验证。

## 验证及后续

2026-11-01 收尾核验：五个保留的新增平台共七组酒店／机票采集均有成功原始响应及数字展示价；JSON、CSV、报告数量与金额已逐项核对，相关适配器及依赖锁文件的当前哈希与实采记录一致。本次收尾没有重新联网询价，展示价采集时间仍以各记录的 `observed_at` 为准。

最新 `npm test` **55 项检查通过（33 项 Python + 22 项 Node）**。回归涵盖：两人参数、登录错误不降级、缺失儿童数保持未知、JPY 不误标 CNY、原始报价不替换为参考换汇价、每晚/全程价分离、优惠券起价保留、HTTP 200 业务错误不算成功、保险附加费不当作票价，以及失败后恢复后台页面状态。新增核对了停用平台不会启动浏览器或新建采集记录，且其历史报价不会计入当前范围；没有个人配置的全新检出可使用示例配置，本地配置仍优先。Expedia 另覆盖当前价/划线原价、每人金额不乘人数和脱敏后保留公开查询条件；去哪儿的历史适配器检查仍保留。测试通过不等于跨平台比价已验收。

本轮通过真实采集入口核对网页、JSON、CSV 和报告，并逐组检查 17 组最新结果的 CSV 行数、金额、价格状态及链接；未改写旧的原始 JSON。依然未验证：最终支付价格、完整库存、全部目的地与日期、App 专属价格，以及同一酒店/房型/政策的跨平台匹配。去哪儿和同程已按用户决定停止接入，不再作为待解决事项；已写探测代码不等于接入完成。

停止接入前的未解决问题（仅作历史留档）：去哪儿账号页已显示登录，但酒店列表请求仍为空响应或访问拒绝（最后一次为 HTTP 204）；同程电脑版已有登录状态，酒店请求仍返回 `-99`，手机页面则明确提示账号异常。页面证据保留在本地 `local/recon/`，不随仓库分发。不能将失败页面显示的“0 家酒店”当作无房。

登录状态复核（2026-11-01）：账号中心显示“退出”，但酒店页仍显示“登录／免费注册”，从酒店页进入登录入口仍展示登录表单；因此不能把账号中心登录成功当作酒店站点已识别会话的证据。最后的酒店复测为 HTTP 204、0 条价格。另用普通 Chrome 打开相同酒店查询，跳转到带酒店返回地址的登录 URL，但页面显示为空白，未完成登录及报价对照；目前不能将故障归因于 Chrome for Testing。交接时分别核对账号中心状态、酒店页状态和是否实际出现报价；`login_required=false` 仅表示当前没有识别到登录页，不代表已登录。HTTP 403／204 也不能单独用来断定平台风控、封号或停服。

人工复核页面交接检查（2026-11-01）：已关闭误留的探索标签 `touch.qunar.com/hotelcn/` 并删除其标签映射，该路径显示 `No match`，不能用于酒店或登录验收。交接前须核对实际前台 URL 为 `hotel.qunar.com/city/i-seoul/`、城市为首尔、日期为 2027-01-08 至 01-10、两位成人。本次正确页面加载通过，但搜索请求仍返回 HTTP 403；同程手机页仍显示账号异常，原因未定位，未认定账号被封或属于未登录。
