import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import { getT, localeFromRequest } from "../i18n";
import { maybePlanDailySync } from "../services/billing.server";

/**
 * 后台框架 + 主导航（M1 脚手架，各页面在后续里程碑补齐）
 *
 * 导航用 App Bridge 的 `s-app-nav` + `s-link`：跳转由客户端接管，
 * 当前所在页面由 App Bridge 依据 URL 自动高亮，不需要手写 active 判断。
 * 套餐页（/app/plans）不占 tab，按方案 §1.6 不照抄竞品的多 tab 结构。
 *
 * M9 起 shell 承担**档位兜底同步**（§七）：距上次向 Shopify 查询 >24h 才查一次
 * （`app_subscriptions/update` webhook 才是主路径）；失败不阻塞后台渲染。
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { admin, session } = await authenticate.admin(request);
    await maybePlanDailySync(admin, session.shop);

    // 优先取 Shopify 附带的 locale 参数，客户端导航时回退到 App Bridge 的 Accept-Language
    const locale = localeFromRequest(request);

    return {
        // eslint-disable-next-line no-undef
        apiKey: process.env.SHOPIFY_API_KEY || "",
        locale,
    };
};

export default function App() {
    const { apiKey, locale } = useLoaderData<typeof loader>();
    const t = getT(locale);

    return (
        <AppProvider embedded apiKey={apiKey}>
            <s-app-nav>
                <s-link href="/app">{t("nav.overview")}</s-link>
                <s-link href="/app/tables">{t("nav.tables")}</s-link>
                <s-link href="/app/wholesale">{t("nav.wholesale")}</s-link>
                <s-link href="/app/design">{t("nav.design")}</s-link>
                <s-link href="/app/help">{t("nav.help")}</s-link>
            </s-app-nav>
            <Outlet />
        </AppProvider>
    );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
    return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
    return boundary.headers(headersArgs);
};