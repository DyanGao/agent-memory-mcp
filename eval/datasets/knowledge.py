"""50 facts that change, and 10 controls that must not replace anything."""

CHANGES = [
    ("the job queue", "RabbitMQ", "NATS"),
    ("the primary database", "MySQL", "Postgres"),
    ("the cache", "Memcached", "Redis"),
    ("internal service calls", "REST", "gRPC"),
    ("the frontend framework", "Vue", "Svelte"),
    ("the bundler", "Webpack", "Vite"),
    ("the test runner", "Jest", "Vitest"),
    ("the package manager", "Yarn", "pnpm"),
    ("the CI system", "Jenkins", "Buildkite"),
    ("the deployment tool", "Capistrano", "Kamal"),
    ("the log pipeline", "Fluentd", "Vector"),
    ("the metrics backend", "Graphite", "Prometheus"),
    ("error tracking", "Rollbar", "Sentry"),
    ("the search engine", "Elasticsearch", "Meilisearch"),
    ("the object store", "MinIO", "Garage"),
    ("the auth provider", "Auth0", "Keycloak"),
    ("the feature flag service", "LaunchDarkly", "Unleash"),
    ("the email provider", "SendGrid", "Postmark"),
    ("the payments provider", "Braintree", "Stripe"),
    ("the CDN", "Fastly", "Cloudflare"),
    ("the container orchestrator", "Nomad", "Kubernetes"),
    ("infrastructure as code", "Terraform", "Pulumi"),
    ("secrets storage", "Vault", "Doppler"),
    ("the mobile framework", "Flutter", "React Native"),
    ("the ORM", "Sequelize", "Drizzle"),
    ("the API gateway", "Kong", "Traefik"),
    ("the linter", "ESLint", "Biome"),
    ("the Python package tool", "Poetry", "uv"),
    ("the data warehouse", "Redshift", "Snowflake"),
    ("the stream processor", "Kafka", "Redpanda"),
    ("the design tool", "Sketch", "Figma"),
    ("the issue tracker", "Jira", "Linear"),
    ("the chat tool", "Slack", "Mattermost"),
    ("the wiki", "Confluence", "Notion"),
    ("the on-call tool", "PagerDuty", "Opsgenie"),
    ("the hosting provider", "Heroku", "Render"),
    ("the cloud provider", "Azure", "Hetzner"),
    ("the state management library", "Redux", "Zustand"),
    ("the CSS approach", "Sass", "Tailwind"),
    ("the date library", "Moment", "Luxon"),
    ("the validation library", "Joi", "Zod"),
    ("the HTTP framework", "Express", "Fastify"),
    ("the web server", "Apache", "Caddy"),
    ("the task scheduler", "Airflow", "Dagster"),
    ("the vector store", "Pinecone", "Qdrant"),
    ("the observability vendor", "Datadog", "Honeycomb"),
    ("the backup tool", "Duplicity", "Restic"),
    ("the VPN", "OpenVPN", "WireGuard"),
    ("the docs generator", "Docusaurus", "Astro"),
    ("the browser test tool", "Cypress", "Playwright"),
]

# Related to each other, but both stay true.
CONTROLS = [
    ("We use Postgres for the primary database.", "We use Redis for the cache.", "Postgres", "Redis"),
    ("Tests run with Vitest in CI.", "Lint runs with ESLint in CI.", "Vitest", "ESLint"),
    ("The API is written in Go.", "The admin panel is written in Ruby.", "Go", "Ruby"),
    ("Deploys go out on Tuesdays.", "Database migrations run on Thursdays.", "Tuesdays", "Thursdays"),
    ("The web app is hosted on Render.", "The docs site is hosted on Netlify.", "Render", "Netlify"),
    ("Sentry tracks backend errors.", "Bugsnag tracks mobile errors.", "Sentry", "Bugsnag"),
    ("Use tabs in Go files.", "Use spaces in Python files.", "tabs", "spaces"),
    ("Staging refreshes nightly.", "Production backups run hourly.", "nightly", "hourly"),
    ("Kafka carries order events.", "NATS carries internal commands.", "Kafka", "NATS"),
    ("Code review needs one approval.", "Security changes need two approvals.", "one", "two"),
]

PHRASINGS = [
    "We have migrated {subject} from {old} to {new}. {old} is gone.",
    "Heads up: {subject} is {new} now, we dropped {old} last week.",
    "We replaced {old} with {new} for {subject}, so nothing uses {old} any more.",
]


def changes() -> list[dict]:
    return [
        {
            "id": f"change-{index}",
            "subject": subject,
            "old": old,
            "new": new,
            "first": f"For {subject} we use {old}. Please keep that in mind.",
            "second": PHRASINGS[index % len(PHRASINGS)].format(
                subject=subject, old=old, new=new
            ),
            "query": f"What do we use for {subject}?",
        }
        for index, (subject, old, new) in enumerate(CHANGES)
    ]
