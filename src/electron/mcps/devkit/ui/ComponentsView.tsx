/**
 * Components Demo View
 *
 * Full UI library demo page showcasing every component from open-mcp-app-ui
 * with live examples and copy-ready code snippets. Single scrollable page
 * with a sticky navigation bar at the top for jumping between sections.
 *
 * Every prop variation is demonstrated with clear labels so developers
 * can visually compare options.
 */

import { useState, useRef, useCallback } from "react";
import {
  Button, Text, Badge, Card, Heading,
  Input, Textarea, Select, Checkbox, Switch,
  Alert, Divider, Show, useDisplayMode,
  RadioGroup, Slider, TagInput, DatePicker, DateRangePicker,
  ToggleGroup, Menu, CodeBlock,
} from "open-mcp-app-ui";
import type { Tag } from "open-mcp-app-ui";
import { DataTable } from "open-mcp-app-ui/table";
import { Editor } from "open-mcp-app-ui/editor";
import {
  LineChart, Line, BarChart, Bar, AreaChart, Area,
  PieChart, Pie, ScatterChart, Scatter,
  RadarChart, Radar, ComposedChart,
  XAxis, YAxis, Tooltip, Legend,
  PolarGrid, PolarAngleAxis,
} from "open-mcp-app-ui/charts";
import {
  Plus, Trash2, Settings, Search, ChevronDown, X, Star,
  Heart, Mail, Bell, Check, AlertCircle, ExternalLink,
  Copy, Download, FileText, Folder,
} from "lucide-react";

// =============================================================================
// Section IDs — used for both the nav select and scroll-to targets.
// =============================================================================

const SECTIONS = [
  { id: "setup", label: "Setup" },
  { id: "layout", label: "Layout & Display Mode" },
  { id: "typography", label: "Typography" },
  { id: "form-controls", label: "Form Controls" },
  { id: "feedback", label: "Feedback & Overlays" },
  { id: "data-display", label: "Data Display" },
  { id: "data-table", label: "Data Table" },
  { id: "editor", label: "Editor" },
  { id: "charts", label: "Charts" },
  { id: "icons", label: "Icons" },
] as const;

// =============================================================================
// Demo Helpers
// =============================================================================

/**
 * Section wrapper for the component demo page.
 * Groups a heading, description, live demo, and code example.
 */
const DemoSection = ({
  title,
  description,
  children,
  code,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
  code: string;
}) => (
  <div className="flex flex-col gap-3">
    <div className="flex flex-col mb-2">
      <Heading level={3} size="sm" className="pb-1">{title}</Heading>
      <Text variant="secondary" size="sm">{description}</Text>
    </div>
    <div className="flex flex-col gap-3">
      {children}
    </div>
    <CodeBlock language="tsx">{code}</CodeBlock>
  </div>
);

/**
 * Label for a variation group inside a demo section.
 * Provides a small header to distinguish different prop demonstrations.
 */
const VariationLabel = ({ children }: { children: string }) => (
  <Text variant="primary" as="div" size="sm" className="font-normal mt-1 mb-0.5">{children}</Text>
);

/**
 * Anchor target for section navigation.
 * Invisible element that sits above the section heading so the scroll
 * lands just above the content.
 */
const SectionAnchor = ({ id }: { id: string }) => (
  <div id={id} className="scroll-mt-14" />
);

/**
 * Live display mode readout for the useDisplayMode demo section.
 * Shows the current values returned by the hook.
 */
const DisplayModeDemo = () => {
  const { displayMode, isInline, isPip, isFullscreen } = useDisplayMode();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="info">{displayMode}</Badge>
      <Text variant="tertiary" as="span" size="sm">
        isInline={String(isInline)} · isPip={String(isPip)} · isFullscreen={String(isFullscreen)}
      </Text>
    </div>
  );
};

/**
 * Creature's spinner — Phosphor Spinner Bold icon.
 * Matches the loading indicator used throughout the Creature desktop app.
 * Accepts a `size` for width/height (defaults to 16px).
 */
const CreatureSpinner = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 256 256"
    fill="currentColor"
    aria-hidden="true"
    className="shrink-0"
    style={{ animation: "spin 2.5s linear infinite" }}
  >
    <path d="M140,32V64a12,12,0,0,1-24,0V32a12,12,0,0,1,24,0Zm33.25,62.75a12,12,0,0,0,8.49-3.52L204.37,68.6a12,12,0,0,0-17-17L164.77,74.26a12,12,0,0,0,8.48,20.49ZM224,116H192a12,12,0,0,0,0,24h32a12,12,0,0,0,0-24Zm-42.26,48.77a12,12,0,1,0-17,17l22.63,22.63a12,12,0,0,0,17-17ZM128,180a12,12,0,0,0-12,12v32a12,12,0,0,0,24,0V192A12,12,0,0,0,128,180ZM74.26,164.77,51.63,187.4a12,12,0,0,0,17,17l22.63-22.63a12,12,0,1,0-17-17ZM76,128a12,12,0,0,0-12-12H32a12,12,0,0,0,0,24H64A12,12,0,0,0,76,128ZM91.37,91.23a12,12,0,0,0,0-17L68.6,51.63a12,12,0,0,0-17,17L74.26,91.23a12,12,0,0,0,17,0Z" />
  </svg>
);

// =============================================================================
// Main View
// =============================================================================

/**
 * Full UI library demo page.
 * Showcases every component from open-mcp-app-ui with live examples
 * and copy-ready code snippets. Single scrollable page with a sticky
 * section navigator at the top.
 */
/**
 * Demo data for the DataTable section.
 * Provides a realistic set of rows to demonstrate sorting, filtering,
 * pagination, and various display states.
 */
const DEMO_TABLE_DATA = [
  { name: "Alice Chen", role: "Engineer", status: "Active", joined: "2024-01-15" },
  { name: "Bob Martinez", role: "Designer", status: "Active", joined: "2024-02-20" },
  { name: "Carol Kim", role: "Manager", status: "Away", joined: "2023-08-10" },
  { name: "David Okafor", role: "Engineer", status: "Active", joined: "2024-03-05" },
  { name: "Eva Johansson", role: "Designer", status: "Inactive", joined: "2023-06-12" },
  { name: "Frank Rossi", role: "Engineer", status: "Active", joined: "2024-04-18" },
  { name: "Grace Liu", role: "Manager", status: "Active", joined: "2023-11-01" },
  { name: "Hassan Ali", role: "Engineer", status: "Away", joined: "2024-05-22" },
];

// =============================================================================
// Chart demo data
// =============================================================================

/**
 * Monthly revenue/cost data for LineChart, AreaChart, and ComposedChart demos.
 */
const CHART_DEMO_LINE = [
  { month: "Jan", revenue: 4000, costs: 2400 },
  { month: "Feb", revenue: 3000, costs: 1398 },
  { month: "Mar", revenue: 5000, costs: 3800 },
  { month: "Apr", revenue: 4780, costs: 3908 },
  { month: "May", revenue: 5890, costs: 4800 },
  { month: "Jun", revenue: 6390, costs: 3800 },
];

/**
 * Category data for BarChart demos.
 */
const CHART_DEMO_BAR = [
  { category: "Electronics", value: 4200 },
  { category: "Clothing", value: 3100 },
  { category: "Books", value: 2800 },
  { category: "Home", value: 1900 },
  { category: "Sports", value: 2400 },
];

/**
 * Pie/donut distribution data.
 */
const CHART_DEMO_PIE = [
  { name: "Desktop", value: 400 },
  { name: "Mobile", value: 300 },
  { name: "Tablet", value: 200 },
  { name: "Other", value: 100 },
];

/**
 * Scatter plot measurements data.
 */
const CHART_DEMO_SCATTER = [
  { x: 60, y: 165 }, { x: 70, y: 170 }, { x: 80, y: 175 },
  { x: 65, y: 160 }, { x: 75, y: 172 }, { x: 85, y: 180 },
  { x: 55, y: 155 }, { x: 90, y: 185 }, { x: 72, y: 168 },
  { x: 68, y: 162 }, { x: 78, y: 176 }, { x: 82, y: 178 },
];

/**
 * Radar chart skills data for multi-dimensional comparison.
 */
const CHART_DEMO_RADAR = [
  { skill: "JS", score: 90 },
  { skill: "CSS", score: 75 },
  { skill: "React", score: 88 },
  { skill: "Node", score: 70 },
  { skill: "SQL", score: 65 },
  { skill: "Design", score: 50 },
];

export const ComponentsView = () => {
  const scrollRef = useRef<HTMLDivElement>(null);

  /* Editor state */
  const [editorValue, setEditorValue] = useState("# Hello World\n\nThis is a **rich text** editor built on *Milkdown*.\n\n- Bullet list item\n- Another item\n\n> A blockquote\n\n```js\nconsole.log('code block');\n```\n");

  /* Form controls state */
  const [switchOn, setSwitchOn] = useState(false);
  const [switchCheckedDisabled] = useState(true);
  const [checkVal, setCheckVal] = useState(true);
  const [radioVal, setRadioVal] = useState("md");
  const [sliderVal, setSliderVal] = useState(50);
  const [sliderOpacity, setSliderOpacity] = useState(0.7);
  const [sliderQuality, setSliderQuality] = useState(75);
  const [tags, setTags] = useState<Tag[]>([
    { value: "react", valid: true },
    { value: "typescript", valid: true },
  ]);
  const [dateVal, setDateVal] = useState("");
  const [dateRange, setDateRange] = useState({ startDate: "", endDate: "" });
  const [selectVal, setSelectVal] = useState("");
  const [selectCountry, setSelectCountry] = useState("");
  const [toggleVal, setToggleVal] = useState("grid");
  const [menuCheck1, setMenuCheck1] = useState(true);
  const [menuCheck2, setMenuCheck2] = useState(false);

  /**
   * Scrolls smoothly to a section when the nav select changes.
   * Uses the scroll container directly instead of scrollIntoView to
   * prevent parent containers from scrolling (which would push the
   * sticky title bar out of view).
   */
  const handleNavChange = useCallback((id: string) => {
    const el = document.getElementById(id);
    const container = scrollRef.current;
    if (el && container) {
      const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
      container.scrollTo({ top: offset, behavior: "smooth" });
    }
  }, []);

  return (
    <div className="flex flex-col flex-1 h-full overflow-hidden">
      {/* ============================================================
          STICKY TITLE BAR
          ============================================================ */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-2 bg-bg-primary shrink-0 border-b border-bdr-secondary"
      >
        <Heading level={2} size="sm" className="whitespace-nowrap">
          open-mcp-app-ui
        </Heading>
        <Select
          options={SECTIONS.map((s) => ({ value: s.id, label: s.label }))}
          value=""
          onChange={handleNavChange}
          placeholder="Jump to section..."
          size="sm"
          block={false}
        />
      </div>

      {/* ============================================================
          SCROLLABLE CONTENT
          ============================================================ */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-2xl px-4 py-6 flex flex-col gap-6">
          {/* Header */}
          <div>
            <Heading level={2} className="pb-3">
              Component Library
            </Heading>
            <Text variant="secondary">
              Component library for MCP Apps. All components are styled via the
              75 CSS variables from the MCP Apps spec, so they adapt to any host
              platform.
            </Text>
          </div>

          {/* ================================================================
              SETUP
              ================================================================ */}
          <SectionAnchor id="setup" />
          <Heading level={2} size="md">
            Setup
          </Heading>

          <div className="flex flex-col gap-3">
            <Heading level={4} size="sm">
              Installation
            </Heading>
            <CodeBlock>{`npm install open-mcp-app open-mcp-app-ui`}</CodeBlock>

            <Heading level={4} size="sm">
              CSS Setup
            </Heading>
            <CodeBlock language="css">{`/* styles.css — import the SDK's Tailwind CSS for utility generation */
@import "open-mcp-app/styles/tailwind.css";`}</CodeBlock>
            <CodeBlock language="tsx">{`// app.tsx — import the UI library styles + your app styles
import "open-mcp-app-ui/styles.css";
import "./styles.css";`}</CodeBlock>

            <Heading level={4} size="sm">
              Component Import
            </Heading>
            <CodeBlock language="tsx">{`import {
  AppLayout, Show, useDisplayMode,
  Button, Input, Textarea, Select, Checkbox, Switch,
  RadioGroup, Slider, TagInput, DatePicker, DateRangePicker,
  ToggleGroup, Menu, CodeBlock,
  Alert, Badge,
  Card, Heading, Text, Divider,
} from "open-mcp-app-ui";`}</CodeBlock>
          </div>

          <Divider spacing="none" />

          {/* ================================================================
              LAYOUT & DISPLAY MODE
              ================================================================ */}
          <SectionAnchor id="layout" />
          <Heading level={2} size="md">
            Layout &amp; Display Mode
          </Heading>

          {/* AppLayout */}
          <DemoSection
            title="AppLayout"
            description="Display-mode-aware root layout. Outer scroll container (no padding) + inner wrapper with adaptive padding/gap. Use `noPadding` for full-bleed layouts (sticky headers, edge-to-edge content)."
            code={`<AppLayout displayMode={hostContext?.displayMode}>
  <MyContent />
</AppLayout>

{/* Full-bleed layout — no inner padding */}
<AppLayout displayMode={hostContext?.displayMode} noPadding>
  <header className="sticky top-0 px-3 py-2 border-b border-bdr-secondary">
    <Heading size="sm">Header</Heading>
  </header>
  <div className="p-3 flex flex-col gap-3">
    <Content />
  </div>
</AppLayout>

// Props:
//   displayMode?: "inline" | "pip" | "fullscreen" (default: "pip")
//   availableDisplayModes?: DisplayMode[]
//   noPadding?: boolean (default: false)`}
          >
            <VariationLabel>Adaptive padding per displayMode</VariationLabel>
            <div className="flex gap-2 flex-wrap">
              <Badge variant="info">inline → p-2, gap-1.5</Badge>
              <Badge variant="info">pip → p-3, gap-3</Badge>
              <Badge variant="info">fullscreen → p-4, gap-4</Badge>
            </div>
            <VariationLabel>noPadding</VariationLabel>
            <Text variant="secondary" size="sm">
              Pass <code className="font-mono text-txt-primary">noPadding</code> to remove inner padding/gap. Children render edge-to-edge inside the scroll container. Add your own spacing per section.
            </Text>
          </DemoSection>

          {/* Show */}
          <DemoSection
            title="Show"
            description="Conditionally render content based on the current display mode."
            code={`<Show on="inline"><Text>Inline only</Text></Show>
<Show on={["pip", "fullscreen"]}><Text>Larger views</Text></Show>
<Show on="fullscreen" fallback={<Text>Not fullscreen</Text>}>
  <Text>Fullscreen content</Text>
</Show>`}
          >
            <VariationLabel>{'on={["pip", "fullscreen"]}'}</VariationLabel>
            <Show on={["pip", "fullscreen"]}>
              <Alert color="info">
                Visible — current mode matches pip or fullscreen.
              </Alert>
            </Show>

            <VariationLabel>on="inline" with fallback</VariationLabel>
            <Show
              on="inline"
              fallback={
                <Text variant="tertiary" size="sm">
                  Hidden — not inline. Fallback shown.
                </Text>
              }
            >
              <Alert color="success">Visible in inline mode.</Alert>
            </Show>
          </DemoSection>

          {/* useDisplayMode */}
          <DemoSection
            title="useDisplayMode"
            description="Hook for programmatic access to the current display mode."
            code={`const { displayMode, isInline, isPip, isFullscreen } = useDisplayMode();`}
          >
            <VariationLabel>Live values</VariationLabel>
            <DisplayModeDemo />
          </DemoSection>

          <Divider spacing="none" />

          {/* ================================================================
              TYPOGRAPHY
              ================================================================ */}
          <SectionAnchor id="typography" />
          <Heading level={2} size="md">
            Typography
          </Heading>

          {/* Heading */}
          <DemoSection
            title="Heading"
            description="Semantic heading element (h1-h6). Visual size is independent of semantic level."
            code={`<Heading level={1} size="3xl">Hero</Heading>
<Heading level={2} size="lg">Section</Heading>
<Heading size="sm">Card Title</Heading>`}
          >
            <VariationLabel>size="3xl"</VariationLabel>
            <Heading level={1} size="3xl">
              Heading 3xl
            </Heading>
            <VariationLabel>size="2xl"</VariationLabel>
            <Heading level={1} size="2xl">
              Heading 2xl
            </Heading>
            <VariationLabel>size="xl"</VariationLabel>
            <Heading level={2} size="xl">
              Heading xl
            </Heading>
            <VariationLabel>size="lg"</VariationLabel>
            <Heading level={2} size="lg">
              Heading lg
            </Heading>
            <VariationLabel>size="md" (default)</VariationLabel>
            <Heading level={3} size="md">
              Heading md
            </Heading>
            <VariationLabel>size="sm"</VariationLabel>
            <Heading level={4} size="sm">
              Heading sm
            </Heading>
            <VariationLabel>size="xs"</VariationLabel>
            <Heading level={5} size="xs">
              Heading xs
            </Heading>
          </DemoSection>

          {/* Text */}
          <DemoSection
            title="Text"
            description="Body text with semantic color variants, sizes, and polymorphic element."
            code={`<Text>Default primary text</Text>
<Text variant="secondary" size="sm">Helper text</Text>
<Text variant="tertiary" as="span">Inline muted</Text>`}
          >
            <VariationLabel>variant="primary" (default)</VariationLabel>
            <Text variant="primary">Primary — standard body text color</Text>
            <VariationLabel>variant="secondary"</VariationLabel>
            <Text variant="secondary">Secondary — reduced emphasis</Text>
            <VariationLabel>variant="tertiary"</VariationLabel>
            <Text variant="tertiary">
              Tertiary — muted / disabled appearance
            </Text>

            <Divider spacing="sm" />

            <VariationLabel>size="sm"</VariationLabel>
            <Text size="sm">Small text for captions and labels</Text>
            <VariationLabel>size="md" (default)</VariationLabel>
            <Text size="md">Medium text for standard body copy</Text>
            <VariationLabel>size="lg"</VariationLabel>
            <Text size="lg">Large text for lead paragraphs</Text>
          </DemoSection>

          <Divider spacing="none" />

          {/* ================================================================
              FORM CONTROLS
              ================================================================ */}
          <SectionAnchor id="form-controls" />
          <Heading level={2} size="md">
            Form Controls
          </Heading>

          {/* Button */}
          <DemoSection
            title="Button"
            description="Action button with semantic variants, sizes, loading, and disabled states."
            code={`<Button variant="primary">Save</Button>
<Button variant="secondary">Cancel</Button>
<Button variant="danger">Delete</Button>
<Button loading>Processing</Button>
<Button loading loadingIcon={<MySpinner />}>Custom Spinner</Button>`}
          >
            <VariationLabel>variant — all 4 variants</VariationLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary">Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="danger">Danger</Button>
              <Button variant="ghost">Ghost</Button>
            </div>

            <VariationLabel>size — sm / md / lg</VariationLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" size="sm">
                Small
              </Button>
              <Button variant="primary" size="md">
                Medium
              </Button>
              <Button variant="primary" size="lg">
                Large
              </Button>
            </div>

            <VariationLabel>loading (with custom loadingIcon)</VariationLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" loading loadingIcon={<CreatureSpinner />}>
                Primary
              </Button>
              <Button variant="secondary" loading loadingIcon={<CreatureSpinner />}>
                Secondary
              </Button>
              <Button variant="danger" loading loadingIcon={<CreatureSpinner />}>
                Danger
              </Button>
              <Button variant="ghost" loading loadingIcon={<CreatureSpinner />}>
                Ghost
              </Button>
            </div>

            <VariationLabel>disabled</VariationLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled>
                Primary
              </Button>
              <Button variant="secondary" disabled>
                Secondary
              </Button>
              <Button variant="danger" disabled>
                Danger
              </Button>
              <Button variant="ghost" disabled>
                Ghost
              </Button>
            </div>
          </DemoSection>

          {/* Input */}
          <DemoSection
            title="Input"
            description="Text input with label, error, helper text, sizes, and disabled state."
            code={`<Input label="Name" placeholder="Enter name..." />
<Input label="Email" error="Invalid email" />
<Input helperText="We won't share this" size="sm" />`}
          >
            <VariationLabel>Default</VariationLabel>
            <Input label="Full Name" placeholder="Enter your name..." />

            <VariationLabel>With helperText</VariationLabel>
            <Input
              label="API Key"
              placeholder="sk-..."
              helperText="Found in your dashboard settings"
            />

            <VariationLabel>With error</VariationLabel>
            <Input
              label="Email"
              placeholder="user@example.com"
              error="Invalid email address"
            />

            <VariationLabel>Sizes (sm / md / lg)</VariationLabel>
            <Input size="sm" placeholder="Small input" />
            <Input size="md" placeholder="Medium input" />
            <Input size="lg" placeholder="Large input" />

            <VariationLabel>disabled</VariationLabel>
            <Input disabled label="Disabled" placeholder="Cannot edit" />
          </DemoSection>

          {/* Textarea */}
          <DemoSection
            title="Textarea"
            description="Multi-line text input with rows, resize control, label, error, and helper text."
            code={`<Textarea label="Description" rows={4} />
<Textarea resize="none" label="Fixed" />
<Textarea label="Bio" helperText="Max 500 chars" />`}
          >
            <VariationLabel>Default (rows=3, resize="vertical")</VariationLabel>
            <Textarea
              label="Description"
              placeholder="Enter a description..."
            />

            <VariationLabel>resize="none"</VariationLabel>
            <Textarea
              label="Fixed Height"
              placeholder="Cannot resize"
              resize="none"
              rows={2}
            />

            <VariationLabel>With error</VariationLabel>
            <Textarea
              label="Notes"
              error="This field is required"
              resize="none"
              rows={2}
            />

            <VariationLabel>disabled</VariationLabel>
            <Textarea
              label="Read-only"
              placeholder="Cannot edit"
              disabled
              rows={2}
            />
          </DemoSection>

          {/* Select */}
          <DemoSection
            title="Select"
            description="Custom dropdown select with keyboard navigation, check marks, option groups, and styled popover."
            code={`<Select
  label="Status"
  placeholder="Choose..."
  value={status}
  onChange={setStatus}
  options={[
    { value: "active", label: "Active" },
    { value: "draft", label: "Draft", disabled: true },
  ]}
/>

// With option groups:
<Select
  label="Country"
  value={country}
  onChange={setCountry}
  options={[
    { label: "North America", options: [
      { value: "us", label: "United States" },
      { value: "ca", label: "Canada" },
    ]},
    { label: "Europe", options: [
      { value: "gb", label: "United Kingdom" },
    ]},
  ]}
/>`}
          >
            <VariationLabel>Default with placeholder</VariationLabel>
            <Select
              label="Status"
              placeholder="Choose a status..."
              value={selectVal}
              onChange={setSelectVal}
              options={[
                { value: "active", label: "Active" },
                { value: "archived", label: "Archived" },
                { value: "draft", label: "Draft", disabled: true },
              ]}
            />

            <VariationLabel>With option groups</VariationLabel>
            <Select
              label="Country"
              placeholder="Select country..."
              value={selectCountry}
              onChange={setSelectCountry}
              options={[
                {
                  label: "North America",
                  options: [
                    { value: "us", label: "United States" },
                    { value: "ca", label: "Canada" },
                    { value: "mx", label: "Mexico" },
                  ],
                },
                {
                  label: "Europe",
                  options: [
                    { value: "gb", label: "United Kingdom" },
                    { value: "de", label: "Germany" },
                    { value: "fr", label: "France" },
                  ],
                },
              ]}
            />

            <VariationLabel>With error</VariationLabel>
            <Select
              label="Priority"
              placeholder="Select..."
              error="Selection required"
              options={[
                { value: "low", label: "Low" },
                { value: "high", label: "High" },
              ]}
            />

            <VariationLabel>disabled</VariationLabel>
            <Select
              disabled
              label="Disabled"
              value="locked"
              options={[{ value: "locked", label: "Locked Value" }]}
            />
          </DemoSection>

          {/* Checkbox */}
          <DemoSection
            title="Checkbox"
            description="Animated boolean toggle with accessible label. Hidden native input with custom animated checkmark."
            code={`<Checkbox label="Accept terms" checked={v} onChange={e => set(e.target.checked)} />
<Checkbox label="Disabled" disabled />
<Checkbox label="Checked + disabled" checked disabled />`}
          >
            <VariationLabel>Interactive (controlled)</VariationLabel>
            <Checkbox
              label="Accept terms and conditions"
              checked={checkVal}
              onChange={(e) => setCheckVal(e.target.checked)}
            />

            <VariationLabel>Unchecked</VariationLabel>
            <Checkbox label="Subscribe to newsletter" />

            <VariationLabel>disabled (unchecked)</VariationLabel>
            <Checkbox label="Unavailable option" disabled />

            <VariationLabel>disabled (checked)</VariationLabel>
            <Checkbox label="Locked selection" checked disabled />
          </DemoSection>

          {/* Switch */}
          <DemoSection
            title="Switch"
            description="Visual on/off toggle built with a button element for accessibility."
            code={`<Switch label="Dark mode" checked={v} onChange={setV} />
<Switch label="Disabled" disabled />
<Switch label="Locked on" checked disabled />`}
          >
            <VariationLabel>Interactive (toggle it)</VariationLabel>
            <Switch
              label="Enable feature"
              checked={switchOn}
              onChange={setSwitchOn}
            />

            <VariationLabel>Checked (on)</VariationLabel>
            <Switch label="Auto-save" checked onChange={() => {}} />

            <VariationLabel>disabled (off)</VariationLabel>
            <Switch label="Unavailable" disabled />

            <VariationLabel>disabled (on)</VariationLabel>
            <Switch
              label="Locked on"
              checked={switchCheckedDisabled}
              disabled
            />
          </DemoSection>

          {/* RadioGroup */}
          <DemoSection
            title="RadioGroup"
            description="Mutually exclusive option selection with animated dot indicator. Supports row and column layouts."
            code={`<RadioGroup value={size} onChange={setSize} aria-label="Size">
  <RadioGroup.Item value="sm">Small</RadioGroup.Item>
  <RadioGroup.Item value="md">Medium</RadioGroup.Item>
  <RadioGroup.Item value="lg">Large</RadioGroup.Item>
</RadioGroup>

// Props:
//   direction?: "row" | "col" (default: "col")
//   disabled?: boolean`}
          >
            <VariationLabel>direction="col" (default)</VariationLabel>
            <RadioGroup
              value={radioVal}
              onChange={setRadioVal}
              aria-label="Size"
            >
              <RadioGroup.Item value="sm">Small</RadioGroup.Item>
              <RadioGroup.Item value="md">Medium</RadioGroup.Item>
              <RadioGroup.Item value="lg">Large</RadioGroup.Item>
            </RadioGroup>

            <VariationLabel>direction="row"</VariationLabel>
            <RadioGroup
              value={radioVal}
              onChange={setRadioVal}
              direction="row"
              aria-label="Size row"
            >
              <RadioGroup.Item value="sm">Small</RadioGroup.Item>
              <RadioGroup.Item value="md">Medium</RadioGroup.Item>
              <RadioGroup.Item value="lg">Large</RadioGroup.Item>
            </RadioGroup>

            <VariationLabel>With disabled item</VariationLabel>
            <RadioGroup
              value={radioVal}
              onChange={setRadioVal}
              aria-label="Size disabled"
            >
              <RadioGroup.Item value="sm">Small</RadioGroup.Item>
              <RadioGroup.Item value="md">Medium</RadioGroup.Item>
              <RadioGroup.Item value="lg" disabled>
                Large (disabled)
              </RadioGroup.Item>
            </RadioGroup>

            <VariationLabel>Entire group disabled</VariationLabel>
            <RadioGroup
              value="md"
              onChange={() => {}}
              disabled
              aria-label="Disabled group"
            >
              <RadioGroup.Item value="sm">Small</RadioGroup.Item>
              <RadioGroup.Item value="md">Medium</RadioGroup.Item>
            </RadioGroup>
          </DemoSection>

          {/* Slider */}
          <DemoSection
            title="Slider"
            description="Range input with optional label, value display, and helper text."
            code={`<Slider label="Volume" value={vol} min={0} max={100}
  onChange={e => setVol(+e.target.value)} showValue />
<Slider label="Opacity" value={0.5} min={0} max={1} step={0.1}
  showValue formatValue={v => \`\${Math.round(v * 100)}%\`} />`}
          >
            <VariationLabel>Default with showValue</VariationLabel>
            <Slider
              label="Volume"
              value={sliderVal}
              min={0}
              max={100}
              showValue
              onChange={(e) =>
                setSliderVal(+(e.target as HTMLInputElement).value)
              }
            />

            <VariationLabel>With formatValue and step</VariationLabel>
            <Slider
              label="Opacity"
              value={sliderOpacity}
              min={0}
              max={1}
              step={0.05}
              showValue
              formatValue={(v) => `${Math.round(v * 100)}%`}
              onChange={(e) =>
                setSliderOpacity(+(e.target as HTMLInputElement).value)
              }
            />

            <VariationLabel>With helperText</VariationLabel>
            <Slider
              label="Quality"
              value={sliderQuality}
              min={0}
              max={100}
              helperText="Higher quality means larger file sizes"
              onChange={(e) =>
                setSliderQuality(+(e.target as HTMLInputElement).value)
              }
            />

            <VariationLabel>disabled</VariationLabel>
            <Slider label="Disabled" value={40} disabled />
          </DemoSection>

          {/* TagInput */}
          <DemoSection
            title="TagInput"
            description="Multi-tag input with keyboard navigation, duplicate detection (shake animation), validation, and max tag limits."
            code={`<TagInput
  label="Tags"
  value={tags}
  onChange={setTags}
  placeholder="Add a tag..."
  maxTags={5}
/>

// Props:
//   validator?: (value: string) => boolean
//   delimiters?: string[] (default: [","])
//   size?: "sm" | "md" | "lg"`}
          >
            <VariationLabel>
              Interactive (try adding/removing tags)
            </VariationLabel>
            <TagInput
              label="Technologies"
              value={tags}
              onChange={setTags}
              placeholder="Add a technology..."
              maxTags={6}
            />

            <VariationLabel>With validation (rejects numbers)</VariationLabel>
            <TagInput
              label="Names"
              placeholder="Letters only..."
              validator={(v) => /^[a-zA-Z]+$/.test(v)}
            />

            <VariationLabel>Size variants (sm / md / lg)</VariationLabel>
            <TagInput size="sm" placeholder="Small..." />
            <TagInput size="md" placeholder="Medium..." />
            <TagInput size="lg" placeholder="Large..." />

            <VariationLabel>With error</VariationLabel>
            <TagInput
              label="Categories"
              error="At least one category is required"
            />

            <VariationLabel>disabled</VariationLabel>
            <TagInput
              label="Locked"
              disabled
              defaultValue={[{ value: "locked", valid: true }]}
            />
          </DemoSection>

          {/* DatePicker */}
          <DemoSection
            title="DatePicker"
            description="Custom calendar dropdown for date selection, fully styled with spec CSS variables."
            code={`<DatePicker label="Start date" value={date}
  onChange={setDate} />
<DatePicker label="Birthday" min="1900-01-01" max="2010-12-31" />`}
          >
            <VariationLabel>Default</VariationLabel>
            <DatePicker
              label="Event Date"
              value={dateVal}
              onChange={setDateVal}
            />

            <VariationLabel>With min/max constraints</VariationLabel>
            <DatePicker
              label="Birthday"
              min="1900-01-01"
              max="2010-12-31"
              helperText="Must be between 1900 and 2010"
            />

            <VariationLabel>With error</VariationLabel>
            <DatePicker label="Due date" error="Date is required" />

            <VariationLabel>disabled</VariationLabel>
            <DatePicker label="Locked" disabled value="2025-01-15" />
          </DemoSection>

          {/* DateRangePicker */}
          <DemoSection
            title="DateRangePicker"
            description="Dual date inputs for selecting a date range with coordinated min/max constraints."
            code={`<DateRangePicker
  label="Trip dates"
  startDate={range.startDate}
  endDate={range.endDate}
  onChange={setRange}
/>

// Props:
//   startLabel?, endLabel? (default: "Start" / "End")
//   min?, max? — global bounds`}
          >
            <VariationLabel>
              Interactive (end auto-constrained by start)
            </VariationLabel>
            <DateRangePicker
              label="Trip dates"
              startDate={dateRange.startDate}
              endDate={dateRange.endDate}
              onChange={setDateRange}
            />

            <VariationLabel>With custom labels</VariationLabel>
            <DateRangePicker
              label="Project timeline"
              startLabel="Kickoff"
              endLabel="Deadline"
              startDate=""
              endDate=""
              onChange={() => {}}
              helperText="Select the project start and end dates"
            />

            <VariationLabel>disabled</VariationLabel>
            <DateRangePicker
              label="Locked range"
              disabled
              startDate="2025-01-01"
              endDate="2025-12-31"
              onChange={() => {}}
            />
          </DemoSection>

          {/* ToggleGroup */}
          <DemoSection
            title="ToggleGroup"
            description="Segmented control for mutually exclusive selection with animated sliding thumb indicator."
            code={`<ToggleGroup value={view} onChange={setView} aria-label="View mode">
  <ToggleGroup.Option value="grid">Grid</ToggleGroup.Option>
  <ToggleGroup.Option value="list">List</ToggleGroup.Option>
</ToggleGroup>

// Props:
//   size?: "sm" | "md" | "lg" (default: "md")
//   block?: boolean — expand to full width
//   pill?: boolean — fully rounded
//   disabled?: boolean`}
          >
            <VariationLabel>Default (size="md")</VariationLabel>
            <ToggleGroup
              value={toggleVal}
              onChange={setToggleVal}
              aria-label="View mode"
            >
              <ToggleGroup.Option value="grid">Grid</ToggleGroup.Option>
              <ToggleGroup.Option value="list">List</ToggleGroup.Option>
              <ToggleGroup.Option value="table">Table</ToggleGroup.Option>
            </ToggleGroup>

            <VariationLabel>size="sm"</VariationLabel>
            <ToggleGroup
              value={toggleVal}
              onChange={setToggleVal}
              size="sm"
              aria-label="View sm"
            >
              <ToggleGroup.Option value="grid">Grid</ToggleGroup.Option>
              <ToggleGroup.Option value="list">List</ToggleGroup.Option>
              <ToggleGroup.Option value="table">Table</ToggleGroup.Option>
            </ToggleGroup>

            <VariationLabel>size="lg"</VariationLabel>
            <ToggleGroup
              value={toggleVal}
              onChange={setToggleVal}
              size="lg"
              aria-label="View lg"
            >
              <ToggleGroup.Option value="grid">Grid</ToggleGroup.Option>
              <ToggleGroup.Option value="list">List</ToggleGroup.Option>
              <ToggleGroup.Option value="table">Table</ToggleGroup.Option>
            </ToggleGroup>

            <VariationLabel>block (full width)</VariationLabel>
            <ToggleGroup
              value={toggleVal}
              onChange={setToggleVal}
              block
              aria-label="View block"
            >
              <ToggleGroup.Option value="grid">Grid</ToggleGroup.Option>
              <ToggleGroup.Option value="list">List</ToggleGroup.Option>
              <ToggleGroup.Option value="table">Table</ToggleGroup.Option>
            </ToggleGroup>

            <VariationLabel>pill</VariationLabel>
            <ToggleGroup
              value={toggleVal}
              onChange={setToggleVal}
              pill
              aria-label="View pill"
            >
              <ToggleGroup.Option value="grid">Grid</ToggleGroup.Option>
              <ToggleGroup.Option value="list">List</ToggleGroup.Option>
              <ToggleGroup.Option value="table">Table</ToggleGroup.Option>
            </ToggleGroup>

            <VariationLabel>disabled</VariationLabel>
            <ToggleGroup
              value="grid"
              onChange={() => {}}
              disabled
              aria-label="View disabled"
            >
              <ToggleGroup.Option value="grid">Grid</ToggleGroup.Option>
              <ToggleGroup.Option value="list">List</ToggleGroup.Option>
            </ToggleGroup>
          </DemoSection>

          {/* Menu */}
          <DemoSection
            title="Menu"
            description="Dropdown menu triggered by a button. Supports items, checkbox items, separators, and labels."
            code={`<Menu>
  <Menu.Trigger><Button>Open</Button></Menu.Trigger>
  <Menu.Content>
    <Menu.Label>Actions</Menu.Label>
    <Menu.Item onSelect={() => alert("Edit")}>Edit</Menu.Item>
    <Menu.Separator />
    <Menu.CheckboxItem checked={v} onCheckedChange={setV}>
      Auto-save
    </Menu.CheckboxItem>
    <Menu.Separator />
    <Menu.Item onSelect={() => {}} danger>Delete</Menu.Item>
  </Menu.Content>
</Menu>`}
          >
            <VariationLabel>Default menu</VariationLabel>
            <Menu>
              <Menu.Trigger>
                <Button variant="secondary" size="sm">
                  Open Menu
                </Button>
              </Menu.Trigger>
              <Menu.Content>
                <Menu.Label>Actions</Menu.Label>
                <Menu.Item onSelect={() => {}}>Edit</Menu.Item>
                <Menu.Item onSelect={() => {}}>Duplicate</Menu.Item>
                <Menu.Separator />
                <Menu.CheckboxItem
                  checked={menuCheck1}
                  onCheckedChange={setMenuCheck1}
                >
                  Auto-save
                </Menu.CheckboxItem>
                <Menu.CheckboxItem
                  checked={menuCheck2}
                  onCheckedChange={setMenuCheck2}
                >
                  Notifications
                </Menu.CheckboxItem>
                <Menu.Separator />
                <Menu.Item onSelect={() => {}} danger>
                  Delete
                </Menu.Item>
              </Menu.Content>
            </Menu>

            <VariationLabel>With align="end"</VariationLabel>
            <div className="flex justify-end">
              <Menu>
                <Menu.Trigger>
                  <Button variant="ghost" size="sm">
                    Options ▾
                  </Button>
                </Menu.Trigger>
                <Menu.Content align="end">
                  <Menu.Item onSelect={() => {}}>Settings</Menu.Item>
                  <Menu.Item onSelect={() => {}}>Help</Menu.Item>
                  <Menu.Separator />
                  <Menu.Item onSelect={() => {}}>Sign out</Menu.Item>
                </Menu.Content>
              </Menu>
            </div>

            <VariationLabel>With disabled items</VariationLabel>
            <Menu>
              <Menu.Trigger>
                <Button variant="secondary" size="sm">
                  Disabled Items
                </Button>
              </Menu.Trigger>
              <Menu.Content>
                <Menu.Item onSelect={() => {}}>Available</Menu.Item>
                <Menu.Item disabled>Unavailable</Menu.Item>
                <Menu.Item disabled>Also unavailable</Menu.Item>
              </Menu.Content>
            </Menu>
          </DemoSection>

          <Divider spacing="none" />

          {/* ================================================================
              FEEDBACK & OVERLAYS
              ================================================================ */}
          <SectionAnchor id="feedback" />
          <Heading level={2} size="md">
            Feedback &amp; Overlays
          </Heading>

          {/* Alert */}
          <DemoSection
            title="Alert"
            description="Status banner with 4 semantic colors and 3 visual variants (outline/soft/solid). Supports title, description, actions, indicator, and dismiss."
            code={`// color: "info" | "success" | "warning" | "danger" (default: "info")
// variant: "outline" | "soft" | "solid" (default: "outline")

<Alert color="info">Message</Alert>
<Alert color="success" variant="soft" title="Done">Saved.</Alert>
<Alert color="danger" variant="solid" dismissible>Error occurred.</Alert>
<Alert color="warning" actions={<Button size="sm">Retry</Button>}>
  Connection lost.
</Alert>`}
          >
            <VariationLabel>
              variant="outline" (default) — all colors
            </VariationLabel>
            <Alert color="info">Info outline — for tips and information.</Alert>
            <Alert color="success">
              Success outline — operation completed.
            </Alert>
            <Alert color="warning">
              Warning outline — proceed with caution.
            </Alert>
            <Alert color="danger">Danger outline — something went wrong.</Alert>

            <VariationLabel>variant="soft" — all colors</VariationLabel>
            <Alert color="info" variant="soft">
              Info soft — tinted background.
            </Alert>
            <Alert color="success" variant="soft">
              Success soft — tinted background.
            </Alert>
            <Alert color="warning" variant="soft">
              Warning soft — tinted background.
            </Alert>
            <Alert color="danger" variant="soft">
              Danger soft — tinted background.
            </Alert>

            <VariationLabel>variant="solid" — all colors</VariationLabel>
            <Alert color="info" variant="solid">
              Info solid — full background.
            </Alert>
            <Alert color="success" variant="solid">
              Success solid — full background.
            </Alert>
            <Alert color="warning" variant="solid">
              Warning solid — full background.
            </Alert>
            <Alert color="danger" variant="solid">
              Danger solid — full background.
            </Alert>

            <VariationLabel>With title</VariationLabel>
            <Alert color="info" title="Tip">
              You can drag items to reorder them.
            </Alert>
            <Alert color="success" variant="soft" title="Saved">
              Your changes have been saved.
            </Alert>

            <VariationLabel>With actions</VariationLabel>
            <Alert
              color="warning"
              title="Connection lost"
              actions={
                <Button variant="secondary" size="sm">
                  Retry
                </Button>
              }
            >
              Please check your internet connection.
            </Alert>

            <VariationLabel>No indicator</VariationLabel>
            <Alert color="info" indicator={false}>
              Alert without an indicator icon.
            </Alert>

            <VariationLabel>dismissible</VariationLabel>
            <Alert color="info" dismissible>
              This alert can be dismissed.
            </Alert>
          </DemoSection>

          {/* Badge */}
          <DemoSection
            title="Badge"
            description="Compact inline status label with 5 semantic variants."
            code={`<Badge variant="info">New</Badge>
<Badge variant="success">Active</Badge>
<Badge variant="warning">Pending</Badge>
<Badge variant="danger">3 errors</Badge>
<Badge variant="secondary">Draft</Badge>`}
          >
            <VariationLabel>All variants</VariationLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="info">Info</Badge>
              <Badge variant="success">Success</Badge>
              <Badge variant="warning">Warning</Badge>
              <Badge variant="danger">Danger</Badge>
              <Badge variant="secondary">Secondary</Badge>
            </div>

            <VariationLabel>Practical usage</VariationLabel>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="info">New</Badge>
              <Badge variant="success">Active</Badge>
              <Badge variant="warning">Pending review</Badge>
              <Badge variant="danger">3 errors</Badge>
              <Badge variant="secondary">v0.0.2</Badge>
            </div>
          </DemoSection>

          <Divider spacing="none" />

          {/* ================================================================
              DATA DISPLAY
              ================================================================ */}
          <SectionAnchor id="data-display" />
          <Heading level={2} size="md">
            Data Display
          </Heading>

          {/* CodeBlock */}
          <DemoSection
            title="CodeBlock"
            description="Monospace code display with copy button, optional language label, and line numbers."
            code={`<CodeBlock language="bash">{code}</CodeBlock>
<CodeBlock language="tsx" showLineNumbers>{code}</CodeBlock>
<CodeBlock copyable={false}>{code}</CodeBlock>

// Props:
//   language?: string — shown in header
//   copyable?: boolean (default: true)
//   showLineNumbers?: boolean (default: false)`}
          >
            <VariationLabel>
              Default with language label and copy
            </VariationLabel>
            <CodeBlock language="tsx">{`import { Button, Card } from "open-mcp-app-ui";

const App = () => (
  <Card>
    <Button variant="primary">Click me</Button>
  </Card>
);`}</CodeBlock>

            <VariationLabel>With line numbers</VariationLabel>
            <CodeBlock
              language="javascript"
              showLineNumbers
            >{`function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

console.log(fibonacci(10));`}</CodeBlock>

            <VariationLabel>No language header (plain)</VariationLabel>
            <CodeBlock
              copyable={false}
            >{`npm install open-mcp-app open-mcp-app-ui`}</CodeBlock>
          </DemoSection>

          {/* Card */}
          <DemoSection
            title="Card"
            description="Bordered content container with variant and padding options."
            code={`<Card>Default card</Card>
<Card variant="ghost" padding="lg">Ghost card</Card>
<Card padding="none">No padding</Card>`}
          >
            <VariationLabel>variant="default"</VariationLabel>
            <Card>
              <Heading level={4} size="sm">
                Default Card
              </Heading>
              <Text variant="secondary" size="sm">
                Has border, shadow, and medium padding.
              </Text>
            </Card>

            <VariationLabel>variant="ghost"</VariationLabel>
            <Card variant="ghost">
              <Text variant="secondary" size="sm">
                Ghost card — transparent, no border.
              </Text>
            </Card>

            <VariationLabel>padding="sm" / "md" / "lg"</VariationLabel>
            <Card padding="sm">
              <Text size="sm">Small padding</Text>
            </Card>
            <Card padding="md">
              <Text size="sm">Medium padding</Text>
            </Card>
            <Card padding="lg">
              <Text size="sm">Large padding</Text>
            </Card>
          </DemoSection>

          {/* Divider */}
          <DemoSection
            title="Divider"
            description="Horizontal separator line with configurable vertical spacing."
            code={`<Divider />
<Divider spacing="none" />
<Divider spacing="sm" />
<Divider spacing="lg" />`}
          >
            <VariationLabel>spacing="none"</VariationLabel>
            <Text variant="secondary" size="sm">
              Above
            </Text>
            <Divider spacing="none" />
            <Text variant="secondary" size="sm">
              Below — no margin
            </Text>

            <VariationLabel>spacing="sm"</VariationLabel>
            <Text variant="secondary" size="sm">
              Above
            </Text>
            <Divider spacing="sm" />
            <Text variant="secondary" size="sm">
              Below — small margin
            </Text>

            <VariationLabel>spacing="md" (default)</VariationLabel>
            <Text variant="secondary" size="sm">
              Above
            </Text>
            <Divider spacing="md" />
            <Text variant="secondary" size="sm">
              Below — medium margin
            </Text>
          </DemoSection>

          {/* ================================================================= */}
          {/* Data Table (separate import: open-mcp-app-ui/table)              */}
          {/* ================================================================= */}

          <SectionAnchor id="data-table" />
          <Heading level={2} size="md" className="mb-4 mt-6">
            Data Table
          </Heading>

          {/* Basic DataTable */}
          <DemoSection
            title="DataTable"
            description="High-performance virtualized data table built on TanStack Table + TanStack Virtual. Separate import from open-mcp-app-ui/table."
            code={`import { DataTable } from "open-mcp-app-ui/table";

const columns = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "role", header: "Role" },
  { accessorKey: "status", header: "Status" },
];

<DataTable columns={columns} data={users} sortable />`}
          >
            <VariationLabel>Sortable (click headers)</VariationLabel>
            <DataTable
              columns={[
                { accessorKey: "name", header: "Name" },
                { accessorKey: "role", header: "Role" },
                { accessorKey: "status", header: "Status" },
                { accessorKey: "joined", header: "Joined" },
              ]}
              data={DEMO_TABLE_DATA}
              sortable
            />

            <VariationLabel>Sortable + Filterable</VariationLabel>
            <DataTable
              columns={[
                { accessorKey: "name", header: "Name" },
                { accessorKey: "role", header: "Role" },
                { accessorKey: "status", header: "Status" },
                { accessorKey: "joined", header: "Joined" },
              ]}
              data={DEMO_TABLE_DATA}
              sortable
              filterable
              filterPlaceholder="Search users..."
            />

            <VariationLabel>Paginated (3 per page)</VariationLabel>
            <DataTable
              columns={[
                { accessorKey: "name", header: "Name" },
                { accessorKey: "role", header: "Role" },
                { accessorKey: "status", header: "Status" },
              ]}
              data={DEMO_TABLE_DATA}
              sortable
              pageSize={3}
            />

            <VariationLabel>Compact</VariationLabel>
            <DataTable
              columns={[
                { accessorKey: "name", header: "Name" },
                { accessorKey: "role", header: "Role" },
                { accessorKey: "status", header: "Status" },
              ]}
              data={DEMO_TABLE_DATA}
              compact
            />

            <VariationLabel>Loading state</VariationLabel>
            <DataTable
              columns={[
                { accessorKey: "name", header: "Name" },
                { accessorKey: "role", header: "Role" },
                { accessorKey: "status", header: "Status" },
              ]}
              data={[]}
              loading
            />

            <VariationLabel>Empty state</VariationLabel>
            <DataTable
              columns={[
                { accessorKey: "name", header: "Name" },
                { accessorKey: "role", header: "Role" },
              ]}
              data={[]}
              emptyMessage="No users found"
            />
          </DemoSection>

          {/* ================================================================= */}
          {/* Editor (separate import: open-mcp-app-ui/editor)                */}
          {/* ================================================================= */}

          <SectionAnchor id="editor" />
          <Heading level={2} size="md" className="mb-4 mt-6">
            Editor
          </Heading>

          {/* Basic Editor */}
          <DemoSection
            title="Editor"
            description="Markdown + rich text editor built on Milkdown (ProseMirror + Remark). Separate import from open-mcp-app-ui/editor. Supports WYSIWYG, raw markdown, and split modes. No border by default — use `bordered` to add one."
            code={`import { Editor } from "open-mcp-app-ui/editor";

<Editor
  value={markdown}
  onChange={setMarkdown}
  placeholder="Start writing..."
/>

{/* With border and rounded corners */}
<Editor value={markdown} onChange={setMarkdown} bordered />`}
          >
            <VariationLabel>WYSIWYG with mode toggle (default, no border)</VariationLabel>
            <Editor
              value={editorValue}
              onChange={setEditorValue}
              placeholder="Start writing..."
              minHeight={200}
              maxHeight={400}
            />

            <VariationLabel>Bordered</VariationLabel>
            <Editor
              value=""
              placeholder="Standalone editor with border..."
              bordered
              minHeight={150}
            />

            <VariationLabel>Read-only</VariationLabel>
            <Editor
              value={"# Read Only\n\nThis content cannot be edited. Great for **previewing** markdown."}
              readOnly
              minHeight={100}
            />

            <VariationLabel>Custom toolbar</VariationLabel>
            <Editor
              value=""
              placeholder="Bold, italic, heading, and link only..."
              toolbar={["bold", "italic", "divider", "heading", "link"]}
              minHeight={100}
            />

            <VariationLabel>No toolbar</VariationLabel>
            <Editor
              value=""
              placeholder="Clean writing surface..."
              toolbar={false}
              minHeight={100}
            />
          </DemoSection>

          {/* ================================================================
              Charts
          ================================================================ */}
          <SectionAnchor id="charts" />
          <Divider />

          <DemoSection
            title="Charts"
            description="Themed chart components built on Recharts. Auto-styled via CSS variables. Separate import from open-mcp-app-ui/charts. 7 chart types: Line, Bar, Area, Pie, Scatter, Radar, Composed."
            code={`import { LineChart, Line, BarChart, Bar, AreaChart, Area, PieChart, Pie,
  ScatterChart, Scatter, RadarChart, Radar, ComposedChart,
  XAxis, YAxis, Tooltip, Legend, PolarGrid, PolarAngleAxis,
} from "open-mcp-app-ui/charts";

<LineChart data={data} height={250}>
  <XAxis dataKey="month" />
  <YAxis />
  <Tooltip />
  <Line dataKey="revenue" />
  <Line dataKey="costs" />
</LineChart>`}
          >
            <VariationLabel>Line Chart (multi-series)</VariationLabel>
            <LineChart
              data={CHART_DEMO_LINE}
              height={220}
            >
              <XAxis dataKey="month" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line dataKey="revenue" name="Revenue" />
              <Line dataKey="costs" name="Costs" />
            </LineChart>

            <VariationLabel>Bar Chart</VariationLabel>
            <BarChart data={CHART_DEMO_BAR} height={220}>
              <XAxis dataKey="category" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="value" name="Sales" />
            </BarChart>

            <VariationLabel>Area Chart</VariationLabel>
            <AreaChart data={CHART_DEMO_LINE} height={220}>
              <XAxis dataKey="month" />
              <YAxis />
              <Tooltip />
              <Area dataKey="revenue" name="Revenue" />
            </AreaChart>

            <VariationLabel>Pie Chart</VariationLabel>
            <PieChart height={250}>
              <Tooltip />
              <Legend />
              <Pie data={CHART_DEMO_PIE} dataKey="value" nameKey="name" />
            </PieChart>

            <VariationLabel>Pie Chart (donut)</VariationLabel>
            <PieChart height={250}>
              <Tooltip />
              <Pie data={CHART_DEMO_PIE} dataKey="value" nameKey="name" innerRadius={60} outerRadius={90} />
            </PieChart>

            <VariationLabel>Scatter Chart</VariationLabel>
            <ScatterChart height={220}>
              <XAxis dataKey="x" name="Weight (kg)" type="number" />
              <YAxis dataKey="y" name="Height (cm)" type="number" />
              <Tooltip />
              <Scatter data={CHART_DEMO_SCATTER} name="Subjects" />
            </ScatterChart>

            <VariationLabel>Radar Chart</VariationLabel>
            <RadarChart data={CHART_DEMO_RADAR} height={250}>
              <PolarGrid />
              <PolarAngleAxis dataKey="skill" />
              <Tooltip />
              <Radar dataKey="score" name="Score" />
            </RadarChart>

            <VariationLabel>Composed Chart (Bar + Line)</VariationLabel>
            <ComposedChart data={CHART_DEMO_LINE} height={220}>
              <XAxis dataKey="month" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="revenue" name="Revenue" />
              <Line dataKey="costs" name="Costs" />
            </ComposedChart>

            <VariationLabel>Custom color palette</VariationLabel>
            <BarChart data={CHART_DEMO_BAR} height={200} colorPalette={["#e74c3c", "#2ecc71", "#3498db"]}>
              <XAxis dataKey="category" />
              <YAxis />
              <Tooltip />
              <Bar dataKey="value" name="Sales" />
            </BarChart>
          </DemoSection>

          {/* ================================================================
              Icons
          ================================================================ */}
          <SectionAnchor id="icons" />
          <Divider />

          <DemoSection
            title="Icons"
            description="lucide-react is bundled as a dependency — no separate install needed. ~1,000 icons, tree-shakeable (~1KB each). Icons use currentColor by default, inheriting theme text color."
            code={`import { Plus, Trash2, Settings, Search, Star, Heart } from "lucide-react";

{/* Inside a Button */}
<Button><Plus size={16} /> Add Item</Button>

{/* Standalone icon */}
<Settings size={20} strokeWidth={1.5} />

{/* With Text */}
<Text variant="secondary" size="sm">
  <AlertCircle size={14} className="inline mr-1" /> Info message
</Text>`}
          >
            <VariationLabel>Common icons at different sizes</VariationLabel>
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-1.5 text-txt-primary">
                <Plus size={16} /> <Text size="sm">Plus (16)</Text>
              </div>
              <div className="flex items-center gap-1.5 text-txt-primary">
                <Settings size={20} /> <Text size="sm">Settings (20)</Text>
              </div>
              <div className="flex items-center gap-1.5 text-txt-primary">
                <Search size={24} /> <Text size="sm">Search (24)</Text>
              </div>
            </div>

            <VariationLabel>Icons in buttons</VariationLabel>
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="primary" size="sm"><Plus size={14} /> Add</Button>
              <Button variant="danger" size="sm"><Trash2 size={14} /> Delete</Button>
              <Button variant="ghost" size="sm"><Copy size={14} /> Copy</Button>
              <Button variant="secondary" size="sm"><Download size={14} /> Export</Button>
            </div>

            <VariationLabel>Icon-only buttons</VariationLabel>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm"><Settings size={16} /></Button>
              <Button variant="ghost" size="sm"><Bell size={16} /></Button>
              <Button variant="ghost" size="sm"><Star size={16} /></Button>
              <Button variant="ghost" size="sm"><Heart size={16} /></Button>
            </div>

            <VariationLabel>Stroke weight variations</VariationLabel>
            <div className="flex items-center gap-4 text-txt-primary">
              <div className="flex items-center gap-1.5">
                <Star size={20} strokeWidth={1} /> <Text size="sm">thin (1)</Text>
              </div>
              <div className="flex items-center gap-1.5">
                <Star size={20} strokeWidth={1.5} /> <Text size="sm">light (1.5)</Text>
              </div>
              <div className="flex items-center gap-1.5">
                <Star size={20} strokeWidth={2} /> <Text size="sm">regular (2)</Text>
              </div>
              <div className="flex items-center gap-1.5">
                <Star size={20} strokeWidth={2.5} /> <Text size="sm">bold (2.5)</Text>
              </div>
            </div>

            <VariationLabel>Status icons with color</VariationLabel>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1.5 text-green-600"><Check size={16} /> <Text size="sm">Success</Text></div>
              <div className="flex items-center gap-1.5 text-red-600"><X size={16} /> <Text size="sm">Error</Text></div>
              <div className="flex items-center gap-1.5 text-yellow-600"><AlertCircle size={16} /> <Text size="sm">Warning</Text></div>
            </div>

            <VariationLabel>Icon categories</VariationLabel>
            <div className="grid grid-cols-4 gap-3 text-txt-secondary">
              <div className="flex flex-col items-center gap-1"><FileText size={20} /><Text size="sm" variant="tertiary">FileText</Text></div>
              <div className="flex flex-col items-center gap-1"><Folder size={20} /><Text size="sm" variant="tertiary">Folder</Text></div>
              <div className="flex flex-col items-center gap-1"><Mail size={20} /><Text size="sm" variant="tertiary">Mail</Text></div>
              <div className="flex flex-col items-center gap-1"><ExternalLink size={20} /><Text size="sm" variant="tertiary">ExternalLink</Text></div>
            </div>
          </DemoSection>

          {/* Bottom spacer */}
          <div className="h-6" />
        </div>
      </div>
    </div>
  );
};
