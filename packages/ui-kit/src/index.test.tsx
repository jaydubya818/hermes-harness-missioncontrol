import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CapacityBar, CostCard, Panel, Sparkline, StatusRow } from "./index.js";

describe("ui-kit", () => {
  it("renders panel title and children", () => {
    const html = renderToStaticMarkup(<Panel title="Missions">content</Panel>);
    expect(html).toContain("Missions");
    expect(html).toContain("content");
  });

  it("computes capacity percentages and clamps overflow to 100%", () => {
    expect(renderToStaticMarkup(<CapacityBar value={5} max={10} />)).toContain("5/10 (50%)");
    expect(renderToStaticMarkup(<CapacityBar value={30} max={10} />)).toContain("30/10 (100%)");
  });

  it("renders 0% instead of dividing by zero when max is 0", () => {
    expect(renderToStaticMarkup(<CapacityBar value={5} max={0} />)).toContain("5/0 (0%)");
  });

  it("switches the capacity bar to the alert color above 85%", () => {
    expect(renderToStaticMarkup(<CapacityBar value={9} max={10} />)).toContain("#fb7185");
    expect(renderToStaticMarkup(<CapacityBar value={8} max={10} />)).toContain("#38bdf8");
  });

  it("renders nothing for an empty sparkline", () => {
    expect(renderToStaticMarkup(<Sparkline values={[]} />)).toBe("");
  });

  it("scales sparkline points to the 0-100 viewBox", () => {
    const html = renderToStaticMarkup(<Sparkline values={[0, 5, 10]} />);
    expect(html).toContain('points="0,100 50,50 100,0"');
  });

  it("anchors a single-value sparkline at the left edge without NaN coordinates", () => {
    const html = renderToStaticMarkup(<Sparkline values={[5]} />);
    expect(html).toContain('points="0,0"');
    expect(html).not.toContain("NaN");
  });

  it("renders status rows and cost cards with their labels and values", () => {
    expect(renderToStaticMarkup(<StatusRow label="Open" value={3} />)).toContain("Open");
    expect(renderToStaticMarkup(<CostCard label="Cost" amount="$1.23" />)).toContain("$1.23");
  });
});
