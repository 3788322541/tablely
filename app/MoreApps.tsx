/**
 * MoreApps — Cross-promotion card shown at the bottom of every page in
 * all 4 zhenjun-built Shopify apps. Each app injects this into its root.tsx
 * to surface the developer's full portfolio of Shopify apps.
 *
 * The card renders the OTHER 3 apps (never the current one) so merchants
 * already using us can discover complementary tools without leaving the
 * Shopify admin. Install links go straight to Shopify App Store install.
 */

type AppEntry = {
  handle: string;          // App Store slug
  name: string;            // Display name
  tagline: string;         // Short value prop (kept under 40 chars)
  logo: string;            // Square app icon URL (from Shopify App Store og:image)
  color: string;           // Accent color hex
  category: string;         // Short category label
};

// Full portfolio — shared across all apps
export const PORTFOLIO: AppEntry[] = [
  {
    handle: "attributly",
    name: "Attributly",
    tagline: "See which ads and UTM links bring real orders",
    logo: "https://cdn.shopify.com/app-store/listing_images/e8969b3ffb042387dcb2b5f57b9430d2/icon/CN-L9d78ipcDEAE=.png",
    color: "#5B8DEF",
    category: "Analytics",
  },
  {
    handle: "tablely",
    name: "Tablely",
    tagline: "Bulk order form for wholesale — every variant in one table",
    logo: "https://cdn.shopify.com/app-store/listing_images/c2b794078d89681a15ccdfac1e50bf13/icon/CJO79LPbupcDEAE=.png",
    color: "#2AB674",
    category: "Wholesale",
  },
  {
    handle: "linkly-2",
    name: "Linkly",
    tagline: "Custom link buttons on product pages — lookbooks, size guides, affiliates",
    logo: "https://cdn.shopify.com/app-store/listing_images/c43edd7940fb6e43541d152e79067c84/icon/CJOGt_X1k5cDEAE=.png",
    color: "#F27B3B",
    category: "Store design",
  },
  {
    handle: "cartly-free-shipping-bar",
    name: "Cartly",
    tagline: "Real‑time free shipping progress bar that boosts AOV",
    logo: "https://cdn.shopify.com/app-store/listing_images/c30c5131ba8e4ede6e5756f0c08544a1/icon/CL3tvOfohJcDEAE=.png",
    color: "#7C5CFF",
    category: "Conversion",
  },
];

// App Store install URL — merchant clicks this → direct install flow
const installUrl = (handle: string) =>
  `https://apps.shopify.com/${handle}?surface=admin_install`;

type Props = { currentHandle: string };

export default function MoreApps({ currentHandle }: Props) {
  const others = PORTFOLIO.filter((a) => a.handle !== currentHandle);
  if (others.length === 0) return null;

  return (
    <section
      className="zhen-moreapps"
      style={{
        margin: "0",
        padding: "12px",
        borderRadius: "14px",
        border: "1px solid #E3E5E7",
        background: "#FAFBFC",
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <div
        style={{
          fontSize: "13px",
          fontWeight: 600,
          color: "#6B7280",
          marginBottom: "10px",
          letterSpacing: "0.02em",
          textTransform: "uppercase",
        }}
      >
        More from zhenjun
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${others.length}, minmax(0, 1fr))`,
          gap: "10px",
        }}
      >
        {others.map((app) => (
          <a
            key={app.handle}
            href={installUrl(app.handle)}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex",
              gap: "10px",
              padding: "12px",
              borderRadius: "10px",
              border: "1px solid #E3E5E7",
              background: "#fff",
              textDecoration: "none",
              color: "inherit",
              transition: "border-color 0.15s, box-shadow 0.15s",
            }}
            onMouseEnter={(e) => {
              const el = e.currentTarget;
              el.style.borderColor = app.color;
              el.style.boxShadow = `0 2px 8px ${app.color}22`;
            }}
            onMouseLeave={(e) => {
              const el = e.currentTarget;
              el.style.borderColor = "#E3E5E7";
              el.style.boxShadow = "none";
            }}
          >
            <img
              aria-hidden
              src={app.logo}
              alt=""
              width={40}
              height={40}
              loading="lazy"
              style={{
                width: "40px",
                height: "40px",
                borderRadius: "10px",
                flexShrink: 0,
                objectFit: "cover",
                background: "#fff",
                border: "1px solid #E3E5E7",
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  marginBottom: "2px",
                }}
              >
                <span
                  style={{
                    fontSize: "13px",
                    fontWeight: 600,
                    color: "#1F2937",
                  }}
                >
                  {app.name}
                </span>
                <span
                  style={{
                    fontSize: "10px",
                    fontWeight: 500,
                    color: "#fff",
                    background: app.color,
                    padding: "1px 6px",
                    borderRadius: "4px",
                    letterSpacing: "0.03em",
                  }}
                >
                  {app.category}
                </span>
              </div>
              <div
                style={{
                  fontSize: "12px",
                  color: "#6B7280",
                  lineHeight: "1.4",
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }}
              >
                {app.tagline}
              </div>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}
