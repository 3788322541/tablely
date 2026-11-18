import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import MoreApps from "../../MoreApps";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

export default function Landing() {
  const { showForm } = useLoaderData<typeof loader>();
  return (
    <div className={styles.page}>
      <div className={styles.index}>
        <main className={styles.content}>
          <div className={styles.badge}>Tablely</div>
          <h1 className={styles.heading}>Wholesale order tables</h1>
          <p className={styles.text}>
            Every variant in one batch order table — wholesale prices visible,
            Shopify Function ensures prices hold at checkout.
          </p>
          {showForm && (
            <Form className={styles.form} method="post" action="/auth/login">
              <input className={styles.input} type="text" name="shop" placeholder="your-shop.myshopify.com" />
              <button className={styles.button} type="submit">Log in</button>
            </Form>
          )}
          <ul className={styles.list}>
            <li><strong>Four layouts.</strong> Table, grid, list, matrix — same rules, four ways to order.</li>
            <li><strong>Prices hold.</strong> What customers see is what they pay at checkout.</li>
            <li><strong>No customer data.</strong> Product refs, order rules, anonymous counts only.</li>
          </ul>
          <div className={styles.footer}>
            <a href="/privacy">Privacy policy</a>
          </div>
        </main>
      </div>
      <div className={styles.moreapps}><MoreApps currentHandle="tablely"  /></div>
    </div>
  );
}
