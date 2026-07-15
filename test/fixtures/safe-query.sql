SELECT
  order_date,
  count(*) AS order_count
FROM analytics.orders
WHERE order_date >= DATE '2026-07-01'
GROUP BY 1
LIMIT 100;
