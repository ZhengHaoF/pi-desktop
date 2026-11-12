# UI 组件规范（`src/renderer/components/ui/`）

> 写新页面 / 新面板时的必读参考。所有界面控件一律使用本目录的共享组件；
> ESLint 已封禁裸写对应原生元素，违反会直接报错。

## 组件清单

| 组件 | 用途 | 替代的原生元素 |
| --- | --- | --- |
| `Button` | 所有按钮（变体 + 尺寸） | `<button>` |
| `Input` | 单行文本 / 密码 / 数字 / 搜索框 | `<input type="text|password|number|search">` 及未标注 type 的文本输入 |
| `Textarea` | 多行文本（JSON 配置、说明文） | `<textarea>` |
| `SecretTextInput` | 密钥 / token 类输入（带显隐切换） | 手写 password + 眼睛按钮 |
| `Select` | 下拉单选（主题化弹层） | `<select>` |
| `Checkbox` | 勾选框（原生 + accent-color） | `<input type="checkbox">` |
| `Switch` | 轨道开关（on/off 状态） | 手写 track+knob 开关 |
| `Dialog` | 居中模态（backdrop/卡片/焦点圈禁/滚动锁） | 手写 fixed 覆盖层 |
| `StatusDot` | 状态小圆点（语义色 + pulse） | 手写 50% 圆角 span |
| `usePopoverAnchor` | portal 弹层贴附触发器的定位 hook | 手写 getBoundingClientRect 逻辑 |

尚未组件化（当前允许裸写）：`checkbox` / `radio` / `file` 输入。计划中的组件见文末。

## 导入方式

```tsx
import { Button } from "@/components/ui/Button";
import { Input, InputSize } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { SecretTextInput } from "@/components/ui/SecretTextInput";
import { Select, SelectOption } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { StatusDot } from "@/components/ui/StatusDot";
import { Switch } from "@/components/ui/Switch";
import { Dialog } from "@/components/ui/Dialog";
```

## Button

```tsx
<Button variant="primary" onClick={save}>保存</Button>
<Button variant="danger" onClick={del}>删除</Button>
<Button variant="ghost" size="icon" title="关闭" onClick={close}>×</Button>
```

- **variant**：`default`（一般操作，可不传）｜ `primary`（确认/主操作）｜ `danger`（删除/解绑）｜ `ghost`（工具条、图标钮）｜ `link`（文字链接钮）｜ `dashed`（空态添加）
- **size**：`md`（默认，32px 高）｜ `sm`（26px，紧凑工具条）｜ `lg`（36px，设置表单行）｜ `icon`（32×32 方形）
- **pressed**：布尔，映射 `aria-pressed`，用于 toggle（吃现成按压样式）
- **block**：拉满父容器宽（表单动作行）

颜色与交互态（hover/active/disabled/pressed）全部由 `globals.css` 的 `.pi-btn*`
class 承担；组件只提供布局默认值。**需要微调布局时传 `style` 或 `className`
覆盖，不要内联颜色**——inline style 会压过 class 的 hover 态。

### 尺寸怎么选

- 与 `Input`/`Select`（36px）同行的动作按钮 → `size="lg"`
- 聊天/侧栏紧凑区 → `md` 或 `sm`
- 纯图标 → `size="icon"`，不要手写 32×32

## Input / Textarea

```tsx
<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" />
<Input type="number" min={1} max={3600} value={timeout} onChange={...} />
<Input type="search" size="sm" value={filter} onChange={...} aria-label="过滤" />
<Input mono value={path} onChange={...} />            {/* 路径/密钥用等宽 */}
<Input invalid={!!error} value={x} onChange={...} />  {/* 错误态红边框 */}
<Textarea value={json} onChange={...} />               {/* 默认等宽，JSON 配置 */}
<Textarea mono={false} value={prose} onChange={...} /> {/* 自然语言文本 */}
```

- **size**：`md`（默认，36px 表单行，与 Button `lg` 同高）｜ `sm`（26px，侧栏过滤、工具条）
- **invalid**：错误态边框（配合表单下方的 `role="alert"` 文案）
- **mono**：等宽字体（路径 / key / JSON）
- 宽度默认 100%，窄输入用 `style={{ width: 96 }}` 覆盖
- 焦点环、placeholder 颜色、disabled 态全部在 `.pi-input` class 里，勿内联

### SecretTextInput

```tsx
<SecretTextInput value={apiKey} onChange={setApiKey} placeholder="sk-…" />
```

自带显隐眼睛按钮（32px 触达目标）、`autoComplete="off"`、值清空自动收回明文。
所有 API key / token 输入用它，不要手写 password 框。

## Select

```tsx
<Select
  value={mode}
  onChange={(value) => setMode(value as Mode)}
  options={[
    { value: "attach", label: "Attach" },
    { value: "managed", label: "Managed" },
    { value: "project", label: "当前项目", disabled: !cwd },
  ]}
/>
```

- **options**：`string[]` 或 `{ value, label, disabled? }[]`；空值槽（如 "— 继承 —"）
  直接作为 `value: ""` 的选项传入
- **placeholder**：value 匹配不到任何选项时触发器显示的文案
- **size**：`md`（默认 36px）｜ `sm`（26px）
- `id` 会落在触发器按钮上，配合 `Field`/`SettingRow` 的 `htmlFor` 关联；`ref`
  透传触发器（React 19 ref-prop，无需 forwardRef）
- 弹层 portal 到 body，自动上下翻转；键盘：↑↓（跳过 disabled）、Home/End、
  Enter 提交、Escape/Tab 关闭、点击外部关闭
- **不要**再写 `<option>` 子元素形式——`options` 数组即数据

## Checkbox

```tsx
<Checkbox checked={enabled} onChange={setEnabled} label="启用" />
<Checkbox size="sm" checked={allSelected} onChange={selectAll} />
<Checkbox id={controlId} checked={x} onChange={setX} aria-describedby={descId} />
```

- **size**：`md`（默认 18px）｜ `sm`（15px，紧凑列表行）
- **label**：可选。传入时组件内置 `<label>` 包裹（隐式关联，label 文本在框后）；
  不传则为裸控件，用于显式关联（`id` + 外部 `htmlFor`、`aria-label`）
- **onChange** 收布尔而非 event；内部仍是原生 `<input type="checkbox">`，
  `indeterminate` 等原生属性透传
- 样式走 `.pi-checkbox`（accent-color var(--accent)）；自绘勾选框是禁手——
  原生控件的暗色正确性与无障碍行为是白拿的

## Switch

```tsx
<Switch
  checked={enabled}
  loading={saving}
  onChange={(next) => setEnabled(next)}
  aria-label="启用此插件"
/>
```

- **必须传 `aria-label`**：控件没有可见文字（轨道 + 滑块），无障碍名全靠它；
  动态文案按状态切换（如 "禁用技能" / "启用技能"）
- **onChange(checked)** 收目标布尔；轨道/滑块样式走 `.pi-switch` + 内置 knob，
  开态强调色、loading 态 busy 光标 + 半透明
- 无障碍用 `role="switch"` + `aria-checked`（不是 pressed toggle）
- 二态"行标签 + 勾选框"的设置行用 `Checkbox`；只有真正的开/关状态用 `Switch`

## Dialog

```tsx
<Dialog open={open} onClose={close} ariaLabel="确认" width={480}>
  <h2 id="confirm-title">确认操作？</h2>
  <Button onClick={confirm}>确定</Button>
</Dialog>
```

- **壳职责**：backdrop + 居中卡片 + 真·焦点圈禁（Tab 循环不出卡片）+
  Escape 关闭 + backdrop 点击关闭 + body 滚动锁；portal 到 body
- **closeOnEscape={false}**：Escape 有专属语义的对话框（如授权框 deny 流程）
- **closeOnBackdrop={false}**：带保存状态门控的确认框
- **width**：默认 480；设置外壳这类大卡传 960 并用 style 覆盖高度/overflow
- 卡片样式（bg-panel/边框/阴影/圆角 9）已内置，内容、按钮、表单处理全部
  留在调用方
- **锚定弹出层**（跟随触发器的 popover，如 herdr 舰队面板、渠道快绑、
  Select 下拉）**不用 Dialog**——它们走 usePopoverAnchor 定位
- ImageLightbox（整屏画布预览）保持独立实现，非卡片形态

## StatusDot

```tsx
<StatusDot color="success" />                                    // 语义色
<StatusDot color={stateColor(process)} size="sm" />              // 动态色
<StatusDot color="accent" pulse />                               // 运行中呼吸
<StatusDot color="success" boxShadow="0 0 4px var(--success)" /> // 光晕
```

- **color**：语义名（`accent/success/danger/warning/muted/border`）或任意 CSS
  颜色（动态状态函数的原样返回值）
- **size**：`md`（8px 默认）｜ `sm`（6px，列表行）
- **pulse**：复用全局 `@keyframes pulse` 的呼吸动画
- **boxShadow**：光晕/圆环（herdr working 态、watch 指示灯）
- 纯装饰元素（`role="presentation"`），状态语义靠相邻文字或 title 传达；
  `.mcp-status-dot` 这类既有 CSS 类保持不动

## 通用约定

1. **ref 是普通 prop**（React 19）：`<Input ref={inputRef} />`，不要用 forwardRef
2. **布局覆盖走 style**：组件默认值覆盖不到的（width、margin、flex）传
   `style`；调用方 style 永远覆盖组件默认
3. **颜色一律走语义 token**（`var(--text)`、`var(--bg-panel)`、`var(--danger)`…），
   禁止硬编码色值；按钮/输入框的交互色直接交给 class，不写 inline
4. **i18n**：用户可见文案一律 `t("key", "English fallback")`；新 key 需同时补
   `i18n-dictionaries.ts` 的中文（`npm run check:i18n` 会查）
5. **aria**：无可见文字的图标按钮必须 `aria-label`；toggle 用 `pressed` 而非手写
   `aria-pressed`

## ESLint 守卫（会报错的写法）

`src/renderer` 内（`ui/` 自身豁免）：

- `pi-btn` 字符串字面量 / `className` 里拼 pi-btn → 用 `<Button variant>`
- 裸 `<button>`、`<select>`、`<textarea>` → 用对应组件
- 带 `type="text|password|number|search|checkbox"` 的裸 `<input>`，以及**未标注
  type** 的 `<input>`（默认即文本框）→ 用 `<Input>` 或 `<Checkbox>`
- `radio` / `file` 暂时放行（组件化后收紧）

个别确需绕过的地方：`// eslint-disable-next-line no-restricted-syntax -- 原因`
（本仓库强制 disable 必须带说明）。ChatInput 的 composer textarea 因自动增高
和 IME 处理整文件豁免。

## 测试约定

- 组件测试放同目录 `*.test.mjs`，用 `importTestBundle` + `renderToStaticMarkup`
  （交互用 react-test-renderer），参考 `ui/button.test.mjs`
- 断言渲染产物时注意 **复合组件会被 findAll 双计**：`<Button>` 的复合实例和其
  内部宿主 `<button>` 都持有相同 props——按宿主过滤
  （`node.type === "string"`）再断言
- 驱动 `Select` 交互需要 DOM 环境 + portal 内联：用共享辅助

  ```js
  import { installDomTestEnvironment, inlinePortalPlugin } from "…/ui/dom-test-env.mjs";
  ```

  并给 `create()` 传 `createNodeMock`（返回 `getBoundingClientRect` 等），
  完整示例见 `ui/select.test.mjs`
- 守卫规则同样作用于测试打包的 tsx 入口，测试里不要手写原生控件

## 改动 checklist

- [ ] 新控件用了 ui 组件而非原生元素？
- [ ] 变体/尺寸选择符合上表语义？
- [ ] 颜色全部走语义 token？
- [ ] 新文案走 i18n 并补了中文字典？
- [ ] 图标按钮有 aria-label？
- [ ] 新组件带 `.test.mjs`？
- [ ] `npm run typecheck && npx eslint src/renderer --max-warnings=0 && npm test` 通过？

## 计划中

- `Menu`（复用 usePopoverAnchor）
