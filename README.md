# WhatsApp Orders to Google Sheets

Event-driven Node.js service that captures shopping-cart orders from a
WhatsApp Business catalog and writes normalized order data to Google Sheets.

This project demonstrates API integration, service-account authentication,
idempotent data ingestion, retry handling, secret management, and automated
testing for a small-business order workflow.

> [!IMPORTANT]
> This proof of concept uses `whatsapp-web.js`, an unofficial WhatsApp Web
> client. It is not endorsed by Meta and may be affected by account
> restrictions or WhatsApp Web changes. The official WhatsApp Business
> Platform is the recommended production path.

## Architecture

```mermaid
flowchart LR
    Customer[Customer cart] --> WA[WhatsApp Business]
    WA --> Client[whatsapp-web.js client]
    Client --> Normalize[Order normalization]
    Normalize --> Dedup[Order ID deduplication]
    Dedup --> Sheets[Google Sheets API]
    Sheets --> Kitchen[(Kitchen orders view)]
    Sheets --> Internal[(Hidden system worksheets)]
    Dedup --> Reply[Customer confirmation]
```

The service accepts WhatsApp catalog carts and, on the conversational branch,
text-based orders. Each accepted order is transformed into a summary record
and one record per product. Google Sheets writes are serialized to prevent
concurrent orders from selecting the same rows.

The `feature/conversational-order-flow` branch also accepts text orders through
a persistent WhatsApp conversation. It collects quantities, validates the
minimum order, asks for the delivery day and fulfillment method, shows the
final total, and writes to Sheets only after the customer replies `SI`.

## Engineering Highlights

- Google Cloud service-account authentication with spreadsheet-scoped access.
- Automatic provisioning of a kitchen-friendly worksheet and internal records.
- Idempotency using the WhatsApp order ID.
- In-process write queue for concurrent order events.
- Atomic multi-range update for the order summary and its line items.
- Retry strategy for delayed WhatsApp order details.
- Persistent WhatsApp session through `LocalAuth`.
- QR and phone-number pairing modes.
- Natural-language pickup and delivery capture from customer replies.
- Brampton and Mississauga delivery fee calculation.
- Allowlist safety control that disables automation for every unapproved chat.
- Fulfillment selection derived from catalog items.
- A single visible worksheet with one row per order and product columns.
- Technical worksheets hidden automatically without deleting source data.
- Safe LID-to-phone resolution for current WhatsApp contact identifiers.
- Customer confirmation only after a successful Sheets write.
- Node.js native test suite and GitHub Actions CI.
- Secrets, authentication state, QR images, and runtime logs excluded from Git.

## Technology

| Area | Technology |
| --- | --- |
| Runtime | Node.js 18+ |
| Messaging | `whatsapp-web.js` |
| Cloud API | Google Sheets API |
| Identity | Google Cloud service account |
| Browser automation | Puppeteer / Chromium |
| Testing | Node.js test runner |
| CI | GitHub Actions |

## Data Model

The only visible worksheet is `Pedidos para cocina`. It uses one row per order
and creates one quantity column per catalog product:

| Order ID | Date and time | Customer | Phone | Delivery or pickup | Notes | Chocolate concha | Vanilla concha | Bolillo |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

The second row shows the total quantity to prepare for each product. New
products automatically become new columns. Delivery catalog items are used to
fill the delivery-or-pickup column and are not counted as food. Technical order
and item records remain in hidden worksheets for deduplication and future
automation.

The `Status` column has two options:

- `Confirmado`: its product quantities are included in `TOTAL A PREPARAR`.
- `Entregado`: it is excluded from totals, displayed in gray, and moved below
  active orders by the background synchronization process.

## Local Setup

### Prerequisites

- Node.js 18 or newer.
- A WhatsApp Business catalog.
- A Google spreadsheet.
- A Google Cloud project with Google Sheets API enabled.
- A Google Cloud service account and JSON key.

### Google Cloud

1. Enable Google Sheets API in a Google Cloud project.
2. Create a service account.
3. Create a JSON key for local development.
4. Share the target spreadsheet with the service account's `client_email` as
   an editor.
5. Store the key outside version control:

```text
.secrets/google-service-account.json
```

Never commit, paste, or distribute the JSON key.

### Application

```powershell
npm.cmd install
Copy-Item .env.example .env
```

Configure `.env`:

```dotenv
GOOGLE_SPREADSHEET_ID=your_spreadsheet_id
GOOGLE_SERVICE_ACCOUNT_FILE=.secrets/google-service-account.json
GOOGLE_ORDERS_SHEET=Orders
GOOGLE_ITEMS_SHEET=Order Items
GOOGLE_PRODUCTION_SHEET=Production
GOOGLE_KITCHEN_SHEET=Kitchen Orders
SEND_CUSTOMER_CONFIRMATION=true
WHATSAPP_AUTH_PATH=.wwebjs_auth
WHATSAPP_PHONE_NUMBER=
WHATSAPP_PRICE_DIVISOR=1000
BRAMPTON_DELIVERY_FEE=5
MISSISSAUGA_DELIVERY_FEE=8
PICKUP_TIME_WINDOW=5:00 p.m. a 6:00 p.m.
WHATSAPP_AUTOMATION_ALLOWLIST=
WHATSAPP_AUTOMATION_ALLOWED_PHONES=
AUTO_REPLY_COOLDOWN_HOURS=24
AUTO_REPLY_STATE_FILE=.data/auto-reply-state.json
CONVERSATION_STATE_FILE=.data/conversation-state.json
MINIMUM_ORDER_PIECES=5
CHOCOLATE_CONCHA_PRICE=3.50
VANILLA_CONCHA_PRICE=3.50
BOLILLO_PRICE=2.50
WEDNESDAY_DELIVERY_WINDOW=después de las 3:00 PM
SATURDAY_DELIVERY_WINDOW=después de las 10:00 AM
```

Start the service:

```powershell
npm.cmd start
```

Without `WHATSAPP_PHONE_NUMBER`, the service generates
`whatsapp-qr.png`. When a phone number is configured in international,
digits-only format, the process displays an eight-character pairing code.

### Safe test mode

Automation is disabled by default. Add only approved test chat IDs:

```dotenv
WHATSAPP_AUTOMATION_ALLOWLIST=123456789@lid
```

Messages and carts from every other chat are ignored. Multiple test IDs can be
separated by commas.

Approved phone numbers can also be listed without symbols. The bot resolves
WhatsApp LIDs before authorizing them:

```dotenv
WHATSAPP_AUTOMATION_ALLOWED_PHONES=14165550123,16475550123
```

### Conversational order flow

Any text from an allowed test chat starts the menu. The conversation proceeds
through:

1. Product preference.
2. Chocolate, vanilla, and bolillo quantities.
3. Minimum-piece validation.
4. Wednesday or Saturday.
5. Free pickup or paid delivery.
6. Brampton or Mississauga when delivery is selected.
7. Final `SI` or `NO` confirmation.

Incomplete and canceled conversations are not written to Google Sheets. A
confirmed delivery remains available for the customer to share their WhatsApp
location. Conversation progress is stored in `.data/conversation-state.json`,
which is excluded from Git.

After confirmation, customers can write `ACTUALIZAR PEDIDO` or use natural
words such as `agregar`, `quitar`, `cambiar`, or `cancelar`. The bot reminds
them of the current order and offers these actions:

- Add or remove a product quantity.
- Change the delivery day.
- Switch between free pickup and delivery.
- Cancel the complete order with a second confirmation.

Changes replace the existing order under the same ID only after `SI`.
Canceled orders remain in the worksheet for history, are excluded from
production totals, and appear as inactive rows.

### Catalog fulfillment items

Add exactly one fulfillment item to each cart:

- `Delivery in Mississauga`
- `Delivery in Brampton`
- `Recoger`

The service recognizes these items as logistics, excludes them from kitchen
quantities, applies the configured fee once, and asks only for the missing
address or schedule information. Conflicting selections are flagged for manual
review.

`PICKUP_TIME_WINDOW` controls the pickup window included in the automatic
customer reply and in the kitchen worksheet notes.

## Testing

```powershell
npm.cmd test
```

The tests cover cart normalization, WhatsApp monetary units, spreadsheet row
shape, the simplified kitchen view, pickup and delivery classification, and
city fees.

## Security

- `.env`, `.secrets/`, WhatsApp authentication state, QR images, and logs are
  excluded by `.gitignore`.
- The service account should receive access only to the target spreadsheet.
- The JSON key should be replaced with workload identity or a managed secret
  when deployed to a cloud environment.
- Customer phone numbers and order details are operational data and require
  appropriate retention and access controls.
- The service never trusts a client-provided calculated total as a payment
  authorization.

## Operations

The service requires continuous network access and persistent storage for
`.wwebjs_auth`. A production-like deployment should include:

- A process supervisor or Windows service with automatic restart.
- Persistent encrypted storage for the WhatsApp session.
- Managed secrets instead of a local JSON key.
- Structured logs, health checks, alerts, and dead-letter handling.
- Periodic dependency and account-link validation.
- A documented migration path to the official WhatsApp Cloud API.

## Current Limitations

- WhatsApp account linking must work before order events can be tested.
- `whatsapp-web.js` depends on private WhatsApp Web behavior.
- In-memory serialization assumes one running service instance.
- Google Sheets is suitable for this workload size, not high-volume
  transactional processing.
- Address-to-city reverse geocoding is not yet automatic when a shared
  location has coordinates but no address text.
- Payment confirmation is not yet part of the workflow.

## Roadmap

- Migrate messaging to the official WhatsApp Business Platform.
- Add delivery or pickup capture with WhatsApp Flows.
- Add PostgreSQL as the system of record and keep Sheets as an operational
  report.
- Package the process as a Windows service.
- Add health endpoints, metrics, alerting, and infrastructure as code.

## License

MIT
