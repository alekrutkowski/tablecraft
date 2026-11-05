/** Small, deterministic examples. Every source is ordinary, portable R code. */
const column = (name, type) => ({ name, type });
const columns = (spec) => spec.map(([name, type]) => column(name, type));

export const SALES_SOURCE = `local({
  i <- seq_len(240L)
  product_names <- c("Notebook", "Desk lamp", "Keyboard", "Headphones", "Monitor", "Backpack")
  prices <- c(12.50, 39, 79, 129, 249, 59)
  product_index <- (i * 5L - 1L) %% 6L + 1L
  data.table(
    order_id = sprintf("ORD-%04d", i),
    date = as.IDate("2026-01-01") + (i - 1L) %% 90L,
    region = c("North", "South", "East", "West")[(i - 1L) %% 4L + 1L],
    product = product_names[product_index],
    units = (i * 7L) %% 9L + 1L,
    unit_price = prices[product_index],
    channel = c("Online", "Retail", "Partner")[(i - 1L) %% 3L + 1L],
    customer_id = sprintf("C%03d", (i * 13L - 1L) %% 40L + 1L)
  )
})`;

const PRODUCTS_SOURCE = `data.table(
  product = c("Notebook", "Desk lamp", "Keyboard", "Headphones", "Monitor", "Backpack"),
  category = c("Stationery", "Home", "Electronics", "Electronics", "Electronics", "Accessories"),
  cost = c(4.50, 18, 32, 55, 145, 24)
)`;

const CUSTOMERS_SOURCE = `local({
  i <- seq_len(40L)
  data.table(
    customer_id = sprintf("C%03d", i),
    customer_name = paste("Customer", i),
    segment = c("Individual", "Business", "Education")[(i - 1L) %% 3L + 1L],
    region = c("North", "South", "East", "West")[(i - 1L) %% 4L + 1L]
  )
})`;

export const LOOKUP_TABLES = [
  {
    id: "products", tableName: "products", label: "Products lookup", rows: 6,
    description: "Match sales to product categories and unit costs.",
    sourceCode: PRODUCTS_SOURCE,
    tablesCode: `products <- ${PRODUCTS_SOURCE}`,
    columns: columns([["product", "character"], ["category", "character"], ["cost", "numeric"]]),
    tags: ["join", "lookup", "synthetic"],
  },
  {
    id: "customers", tableName: "customers", label: "Customers lookup", rows: 40,
    description: "Customer segments and regions for join experiments.",
    sourceCode: CUSTOMERS_SOURCE,
    tablesCode: `customers <- ${CUSTOMERS_SOURCE}`,
    columns: columns([["customer_id", "character"], ["customer_name", "character"], ["segment", "character"], ["region", "character"]]),
    tags: ["join", "lookup", "synthetic"],
  },
];

export const DATASETS = [
  {
    id: "sales", tableName: "sales", label: "Shop sales", rows: 240,
    description: "Orders, products, regions, and prices. A useful starting point for grouping, joins, and windows.",
    sourceCode: SALES_SOURCE,
    columns: columns([["order_id", "character"], ["date", "IDate"], ["region", "character"], ["product", "character"], ["units", "integer"], ["unit_price", "numeric"], ["channel", "character"], ["customer_id", "character"]]),
    tags: ["recommended", "group", "join", "synthetic"],
  },
  {
    id: "iris", tableName: "iris", label: "Iris flowers", rows: 150,
    description: "Flower measurements across three species.",
    sourceCode: "as.data.table(datasets::iris)",
    columns: columns([["Sepal.Length", "numeric"], ["Sepal.Width", "numeric"], ["Petal.Length", "numeric"], ["Petal.Width", "numeric"], ["Species", "factor"]]),
    tags: ["group", "numeric"],
  },
  {
    id: "mtcars", tableName: "mtcars", label: "Motor cars", rows: 32,
    description: "Car models, fuel consumption, engine, and transmission characteristics.",
    sourceCode: 'as.data.table(datasets::mtcars, keep.rownames = "model")',
    columns: columns([["model", "character"], ["mpg", "numeric"], ["cyl", "numeric"], ["disp", "numeric"], ["hp", "numeric"], ["drat", "numeric"], ["wt", "numeric"], ["qsec", "numeric"], ["vs", "numeric"], ["am", "numeric"], ["gear", "numeric"], ["carb", "numeric"]]),
    tags: ["numeric", "filter", "rank"],
  },
  {
    id: "airquality", tableName: "airquality", label: "Air quality", rows: 153,
    description: "Daily weather and air measurements with missing observations.",
    sourceCode: "as.data.table(datasets::airquality)",
    columns: columns([["Ozone", "integer"], ["Solar.R", "integer"], ["Wind", "numeric"], ["Temp", "integer"], ["Month", "integer"], ["Day", "integer"]]),
    tags: ["missing", "window", "numeric"],
  },
  {
    id: "plantgrowth", tableName: "plant_growth", label: "Plant growth", rows: 30,
    description: "Plant weights in a control and two treatment groups.",
    sourceCode: "as.data.table(datasets::PlantGrowth)",
    columns: columns([["weight", "numeric"], ["group", "factor"]]),
    tags: ["group", "small"],
  },
  {
    id: "toothgrowth", tableName: "tooth_growth", label: "Tooth growth", rows: 60,
    description: "Tooth length, supplement, and dose in a small experimental dataset.",
    sourceCode: "as.data.table(datasets::ToothGrowth)",
    columns: columns([["len", "numeric"], ["supp", "factor"], ["dose", "numeric"]]),
    tags: ["group", "reshape"],
  },
  {
    id: "chickwts", tableName: "chickwts", label: "Chick weights", rows: 71,
    description: "Weights of chickens raised on six different feeds.",
    sourceCode: "as.data.table(datasets::chickwts)",
    columns: columns([["weight", "numeric"], ["feed", "factor"]]),
    tags: ["group", "rank"],
  },
  {
    id: "co2", tableName: "co2", label: "CO2 uptake", rows: 84,
    description: "Plant uptake at several concentrations, with type and treatment groups.",
    sourceCode: "as.data.table(datasets::CO2)",
    columns: columns([["Plant", "ordered/factor"], ["Type", "factor"], ["Treatment", "factor"], ["conc", "numeric"], ["uptake", "numeric"]]),
    tags: ["group", "reshape"],
  },
  {
    id: "usarrests", tableName: "us_arrests", label: "US arrests", rows: 50,
    description: "Historical US state statistics with state names retained as a column.",
    sourceCode: 'as.data.table(datasets::USArrests, keep.rownames = "state")',
    columns: columns([["state", "character"], ["Murder", "numeric"], ["Assault", "integer"], ["UrbanPop", "integer"], ["Rape", "numeric"]]),
    tags: ["numeric", "melt"],
  },
  {
    id: "sales_long", tableName: "sales_long", label: "Monthly metrics", rows: 48,
    description: "Long-form monthly orders and revenue, ready to reshape with dcast.",
    sourceCode: `CJ(
  month = as.IDate(c("2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01")),
  region = c("North", "South", "East", "West"),
  metric = c("orders", "revenue")
) %>% .[, value := fifelse(metric == "orders", 40 + .I * 3, 1200 + .I * 57)]`,
    columns: columns([["month", "IDate"], ["region", "character"], ["metric", "character"], ["value", "numeric"]]),
    tags: ["dcast", "reshape", "synthetic"],
  },
  ...LOOKUP_TABLES,
];

export const getDataset = (id) => DATASETS.find((dataset) => dataset.id === id);
