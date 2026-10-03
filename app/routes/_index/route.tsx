import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Tablely — wholesale order tables</h1>
        <p className={styles.text}>
          Turn variant-by-variant clicking into a single batch order table.
          Wholesale customers pick quantities for many variants at once, add the
          whole order to the cart in one go, and see your tiered or wholesale
          prices right on the product page.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Four layouts</strong>. Table, grid, list and matrix — the same
            rules, four ways to order.
          </li>
          <li>
            <strong>Wholesale rules that hold at checkout</strong>. Tiered and
            wholesale prices are applied by a Shopify Function, so the price the
            customer sees is the price they pay.
          </li>
          <li>
            <strong>No customer data stored</strong>. Only product references,
            order-form rules and anonymous per-day add-to-cart counts.
          </li>
        </ul>
      </div>
    </div>
  );
}