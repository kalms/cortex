/*
 * service_patterns.c — Classify call edges by library identity in resolved QN.
 *
 * Instead of matching callee names (ambiguous: "get", "post", "send"),
 * we match library identifiers in the RESOLVED qualified name. The QN
 * contains the full module path, so import aliases are transparent:
 *   r.get("/api") → QN: project.venv.requests.api.get → match "requests" → HTTP_CALLS
 *
 * Two-level matching:
 *   1. Library identifier in QN → determines edge type (HTTP/ASYNC/CONFIG)
 *   2. Method suffix → determines HTTP method (get→GET, post→POST)
 */
#include "service_patterns.h"

#include <stdbool.h>
#include <stddef.h>
#include <string.h>

/* ── Library identifier → edge type ────────────────────────────── */

typedef struct {
    const char *library_id; /* substring to find in resolved QN */
    ctx_svc_kind_t kind;    /* HTTP_CALLS, ASYNC_CALLS, CONFIGURES */
    const char *broker;     /* for ASYNC: broker name (NULL otherwise) */
} lib_pattern_t;

/* HTTP client libraries — match these substrings in the resolved QN.
 * Sources: github.com/easybase/awesome-http, official SDK docs, agent research */
static const lib_pattern_t http_libraries[] = {
    /* Python */
    {"requests", CTX_SVC_HTTP, NULL},
    {"httpx", CTX_SVC_HTTP, NULL},
    {"aiohttp", CTX_SVC_HTTP, NULL},
    {"urllib", CTX_SVC_HTTP, NULL},
    {"urllib3", CTX_SVC_HTTP, NULL},
    {"httplib2", CTX_SVC_HTTP, NULL},
    {"pycurl", CTX_SVC_HTTP, NULL},
    {"treq", CTX_SVC_HTTP, NULL},
    {"uplink", CTX_SVC_HTTP, NULL},

    /* JavaScript / TypeScript */
    {"axios", CTX_SVC_HTTP, NULL},
    {"superagent", CTX_SVC_HTTP, NULL},
    {"needle", CTX_SVC_HTTP, NULL},
    {"node-fetch", CTX_SVC_HTTP, NULL},
    {"undici", CTX_SVC_HTTP, NULL},
    {"ofetch", CTX_SVC_HTTP, NULL},
    {"wretch", CTX_SVC_HTTP, NULL},
    {"sindresorhus/ky", CTX_SVC_HTTP, NULL},
    {"phin", CTX_SVC_HTTP, NULL},

    /* Go */
    {"net/http", CTX_SVC_HTTP, NULL},
    {"resty", CTX_SVC_HTTP, NULL},
    {"sling", CTX_SVC_HTTP, NULL},
    {"heimdall", CTX_SVC_HTTP, NULL},
    {"gentleman", CTX_SVC_HTTP, NULL},
    {"retryablehttp", CTX_SVC_HTTP, NULL},

    /* Java / Kotlin */
    {"HttpClient", CTX_SVC_HTTP, NULL},
    {"OkHttp", CTX_SVC_HTTP, NULL},
    {"okhttp3", CTX_SVC_HTTP, NULL},
    {"RestTemplate", CTX_SVC_HTTP, NULL},
    {"WebClient", CTX_SVC_HTTP, NULL},
    {"Unirest", CTX_SVC_HTTP, NULL},
    {"AsyncHttpClient", CTX_SVC_HTTP, NULL},
    {"apache.http", CTX_SVC_HTTP, NULL},
    {"Retrofit", CTX_SVC_HTTP, NULL},
    {"Feign", CTX_SVC_HTTP, NULL},
    {"ktor.client", CTX_SVC_HTTP, NULL},
    {"kittinunf.fuel", CTX_SVC_HTTP, NULL},

    /* Rust */
    {"reqwest", CTX_SVC_HTTP, NULL},
    {"hyper", CTX_SVC_HTTP, NULL},
    {"surf", CTX_SVC_HTTP, NULL},
    {"ureq", CTX_SVC_HTTP, NULL},
    {"isahc", CTX_SVC_HTTP, NULL},
    {"attohttpc", CTX_SVC_HTTP, NULL},

    /* C# */
    {"HttpClient", CTX_SVC_HTTP, NULL},
    {"RestSharp", CTX_SVC_HTTP, NULL},
    {"Flurl", CTX_SVC_HTTP, NULL},
    {"Refit", CTX_SVC_HTTP, NULL},

    /* Ruby */
    {"HTTParty", CTX_SVC_HTTP, NULL},
    {"Faraday", CTX_SVC_HTTP, NULL},
    {"RestClient", CTX_SVC_HTTP, NULL},
    {"Typhoeus", CTX_SVC_HTTP, NULL},
    {"Excon", CTX_SVC_HTTP, NULL},
    {"Net::HTTP", CTX_SVC_HTTP, NULL},

    /* PHP */
    {"Guzzle", CTX_SVC_HTTP, NULL},
    {"guzzle", CTX_SVC_HTTP, NULL},
    {"curl", CTX_SVC_HTTP, NULL},
    {"Symfony\\HttpClient", CTX_SVC_HTTP, NULL},

    /* C/C++ */
    {"cpr", CTX_SVC_HTTP, NULL},
    {"cpp-httplib", CTX_SVC_HTTP, NULL},
    {"Poco.Net", CTX_SVC_HTTP, NULL},
    {"Beast", CTX_SVC_HTTP, NULL},

    /* Swift */
    {"Alamofire", CTX_SVC_HTTP, NULL},
    {"Moya", CTX_SVC_HTTP, NULL},
    {"URLSession", CTX_SVC_HTTP, NULL},

    /* Dart */
    {"Dio", CTX_SVC_HTTP, NULL},
    {"dio", CTX_SVC_HTTP, NULL},
    {"package:http", CTX_SVC_HTTP, NULL},
    {"Chopper", CTX_SVC_HTTP, NULL},

    /* Elixir */
    {"HTTPoison", CTX_SVC_HTTP, NULL},
    {"Tesla", CTX_SVC_HTTP, NULL},
    {"Finch", CTX_SVC_HTTP, NULL},
    {"Mint.HTTP", CTX_SVC_HTTP, NULL},

    /* Scala */
    {"sttp", CTX_SVC_HTTP, NULL},
    {"akka.http", CTX_SVC_HTTP, NULL},
    {"http4s", CTX_SVC_HTTP, NULL},
    {"scalaj", CTX_SVC_HTTP, NULL},

    /* Haskell */
    {"wreq", CTX_SVC_HTTP, NULL},
    {"http-client", CTX_SVC_HTTP, NULL},
    {"http-conduit", CTX_SVC_HTTP, NULL},
    {"servant-client", CTX_SVC_HTTP, NULL},
    {"Network.HTTP", CTX_SVC_HTTP, NULL},

    /* Lua */
    {"socket.http", CTX_SVC_HTTP, NULL},
    {"resty.http", CTX_SVC_HTTP, NULL},

    {NULL, CTX_SVC_NONE, NULL},
};

/* Async dispatch / message broker libraries */
static const lib_pattern_t async_libraries[] = {
    /* GCP */
    {"cloudtasks", CTX_SVC_ASYNC, "cloud_tasks"},
    {"cloud_tasks", CTX_SVC_ASYNC, "cloud_tasks"},
    {"cloud.tasks", CTX_SVC_ASYNC, "cloud_tasks"},
    {"CloudTasks", CTX_SVC_ASYNC, "cloud_tasks"},
    {"pubsub", CTX_SVC_ASYNC, "pubsub"},
    {"cloud.pubsub", CTX_SVC_ASYNC, "pubsub"},
    {"PubSub", CTX_SVC_ASYNC, "pubsub"},

    /* AWS — use SDK module paths to avoid false positives */
    {"aws-sdk-go/service/sqs", CTX_SVC_ASYNC, "sqs"},
    {"aws_sdk_sqs", CTX_SVC_ASYNC, "sqs"},
    {"Amazon.SQS", CTX_SVC_ASYNC, "sqs"},
    {"@aws-sdk/client-sqs", CTX_SVC_ASYNC, "sqs"},
    {"boto3.client.sqs", CTX_SVC_ASYNC, "sqs"},
    {"aws-sdk-go/service/sns", CTX_SVC_ASYNC, "sns"},
    {"aws_sdk_sns", CTX_SVC_ASYNC, "sns"},
    {"Amazon.SNS", CTX_SVC_ASYNC, "sns"},
    {"@aws-sdk/client-sns", CTX_SVC_ASYNC, "sns"},
    {"eventbridge", CTX_SVC_ASYNC, "eventbridge"},
    {"EventBridge", CTX_SVC_ASYNC, "eventbridge"},
    {"aws-sdk-go/service/lambda", CTX_SVC_ASYNC, "lambda"},
    {"aws_sdk_lambda", CTX_SVC_ASYNC, "lambda"},
    {"@aws-sdk/client-lambda", CTX_SVC_ASYNC, "lambda"},
    {"stepfunctions", CTX_SVC_ASYNC, "stepfunctions"},

    /* Azure */
    {"ServiceBus", CTX_SVC_ASYNC, "servicebus"},
    {"Azure.Messaging", CTX_SVC_ASYNC, "servicebus"},

    /* Kafka */
    {"kafka", CTX_SVC_ASYNC, "kafka"},
    {"Kafka", CTX_SVC_ASYNC, "kafka"},
    {"kafkajs", CTX_SVC_ASYNC, "kafka"},
    {"sarama", CTX_SVC_ASYNC, "kafka"},
    {"rdkafka", CTX_SVC_ASYNC, "kafka"},
    {"confluent", CTX_SVC_ASYNC, "kafka"},
    {"Confluent.Kafka", CTX_SVC_ASYNC, "kafka"},

    /* RabbitMQ */
    {"amqp", CTX_SVC_ASYNC, "rabbitmq"},
    {"AMQP", CTX_SVC_ASYNC, "rabbitmq"},
    {"amqplib", CTX_SVC_ASYNC, "rabbitmq"},
    {"RabbitMQ", CTX_SVC_ASYNC, "rabbitmq"},
    {"lapin", CTX_SVC_ASYNC, "rabbitmq"},
    {"MassTransit", CTX_SVC_ASYNC, "rabbitmq"},

    /* NATS */
    {"nats", CTX_SVC_ASYNC, "nats"},
    {"NATS", CTX_SVC_ASYNC, "nats"},

    /* Redis pub/sub */
    {"ioredis", CTX_SVC_ASYNC, "redis"},

    /* Task queues */
    {"celery", CTX_SVC_ASYNC, "celery"},
    {"Celery", CTX_SVC_ASYNC, "celery"},
    {"dramatiq", CTX_SVC_ASYNC, "dramatiq"},
    {"huey", CTX_SVC_ASYNC, "huey"},
    {"python-rq", CTX_SVC_ASYNC, "rq"},
    {"rq.Queue", CTX_SVC_ASYNC, "rq"},
    {"bullmq", CTX_SVC_ASYNC, "bullmq"},
    {"BullMQ", CTX_SVC_ASYNC, "bullmq"},
    {"bull.Queue", CTX_SVC_ASYNC, "bull"},
    {"Sidekiq", CTX_SVC_ASYNC, "sidekiq"},
    {"sidekiq", CTX_SVC_ASYNC, "sidekiq"},
    {"Resque", CTX_SVC_ASYNC, "resque"},
    {"GoodJob", CTX_SVC_ASYNC, "goodjob"},
    {"DelayedJob", CTX_SVC_ASYNC, "delayed_job"},
    {"Hangfire", CTX_SVC_ASYNC, "hangfire"},
    {"NServiceBus", CTX_SVC_ASYNC, "nservicebus"},
    {"asynq", CTX_SVC_ASYNC, "asynq"},
    {"RichardKnop/machinery", CTX_SVC_ASYNC, "machinery"},

    /* Workflow engines — use specific module paths to avoid "Temporal" in Django etc. */
    {"temporalio", CTX_SVC_ASYNC, "temporal"},
    {"@temporalio", CTX_SVC_ASYNC, "temporal"},
    {"temporal.client", CTX_SVC_ASYNC, "temporal"},
    {"temporal.worker", CTX_SVC_ASYNC, "temporal"},
    {"inngest", CTX_SVC_ASYNC, "inngest"},

    /* Elixir */
    {"Oban", CTX_SVC_ASYNC, "oban"},
    {"Broadway", CTX_SVC_ASYNC, "broadway"},
    {"GenStage", CTX_SVC_ASYNC, "genstage"},
    {"Phoenix.PubSub", CTX_SVC_ASYNC, "phoenix_pubsub"},

    /* Scala */
    {"Alpakka", CTX_SVC_ASYNC, "alpakka"},

    {NULL, CTX_SVC_NONE, NULL},
};

/* Config accessor libraries */
static const lib_pattern_t config_libraries[] = {
    /* Universal */
    {"getenv", CTX_SVC_CONFIG, NULL},
    {"Getenv", CTX_SVC_CONFIG, NULL},
    {"getEnv", CTX_SVC_CONFIG, NULL},
    {"LookupEnv", CTX_SVC_CONFIG, NULL},
    {"lookupEnv", CTX_SVC_CONFIG, NULL},
    {"get_env", CTX_SVC_CONFIG, NULL},
    {"fetch_env", CTX_SVC_CONFIG, NULL},
    {"GetEnvironmentVariable", CTX_SVC_CONFIG, NULL},
    {"getProperty", CTX_SVC_CONFIG, NULL},
    {"getEnvironment", CTX_SVC_CONFIG, NULL},

    /* Go */
    {"viper", CTX_SVC_CONFIG, NULL},
    {"envconfig", CTX_SVC_CONFIG, NULL},
    {"godotenv", CTX_SVC_CONFIG, NULL},

    /* Python */
    {"decouple", CTX_SVC_CONFIG, NULL},
    {"dynaconf", CTX_SVC_CONFIG, NULL},
    {"dotenv", CTX_SVC_CONFIG, NULL},

    /* JS/TS */
    {"nconf", CTX_SVC_CONFIG, NULL},
    {"convict", CTX_SVC_CONFIG, NULL},
    {"envalid", CTX_SVC_CONFIG, NULL},

    /* Rust */
    {"dotenvy", CTX_SVC_CONFIG, NULL},
    {"figment", CTX_SVC_CONFIG, NULL},
    {"config-rs", CTX_SVC_CONFIG, NULL},

    /* Java/Scala */
    {"ConfigFactory", CTX_SVC_CONFIG, NULL},
    {"ConfigurationProperties", CTX_SVC_CONFIG, NULL},

    /* Elixir */
    {"Application.get_env", CTX_SVC_CONFIG, NULL},
    {"Application.fetch_env", CTX_SVC_CONFIG, NULL},

    {NULL, CTX_SVC_NONE, NULL},
};

/* Route registration frameworks — callee resolves to one of these AND
 * has an HTTP method suffix → CTX_SVC_ROUTE_REG.
 * Distinguished from HTTP clients: "gin.GET" registers a handler,
 * "requests.get" makes an outbound HTTP call. */
static const lib_pattern_t route_reg_libraries[] = {
    /* Go */
    {"gin-gonic/gin", CTX_SVC_ROUTE_REG, NULL},
    {"gin.", CTX_SVC_ROUTE_REG, NULL},
    {"go-chi/chi", CTX_SVC_ROUTE_REG, NULL},
    {"chi.", CTX_SVC_ROUTE_REG, NULL},
    {"gorilla/mux", CTX_SVC_ROUTE_REG, NULL},
    {"labstack/echo", CTX_SVC_ROUTE_REG, NULL},
    {"echo.", CTX_SVC_ROUTE_REG, NULL},
    {"gofiber/fiber", CTX_SVC_ROUTE_REG, NULL},
    {"fiber.", CTX_SVC_ROUTE_REG, NULL},
    {"net/http.ServeMux", CTX_SVC_ROUTE_REG, NULL},
    {"http.ServeMux", CTX_SVC_ROUTE_REG, NULL},
    {"httprouter", CTX_SVC_ROUTE_REG, NULL},

    /* JavaScript / TypeScript */
    {"express", CTX_SVC_ROUTE_REG, NULL},
    {"fastify", CTX_SVC_ROUTE_REG, NULL},
    {"koa-router", CTX_SVC_ROUTE_REG, NULL},
    {"hono", CTX_SVC_ROUTE_REG, NULL},
    {"hapi", CTX_SVC_ROUTE_REG, NULL},

    /* Python (non-decorator, e.g., Flask add_url_rule) */
    {"flask", CTX_SVC_ROUTE_REG, NULL},
    {"FastAPI", CTX_SVC_ROUTE_REG, NULL},
    {"starlette", CTX_SVC_ROUTE_REG, NULL},

    /* PHP */
    {"Laravel", CTX_SVC_ROUTE_REG, NULL},
    {"Illuminate.Routing", CTX_SVC_ROUTE_REG, NULL},
    {"Symfony.Routing", CTX_SVC_ROUTE_REG, NULL},

    /* Kotlin */
    {"ktor.server", CTX_SVC_ROUTE_REG, NULL},
    {"ktor.routing", CTX_SVC_ROUTE_REG, NULL},

    /* Rust */
    {"actix-web", CTX_SVC_ROUTE_REG, NULL},
    {"actix_web", CTX_SVC_ROUTE_REG, NULL},
    {"axum", CTX_SVC_ROUTE_REG, NULL},
    {"rocket", CTX_SVC_ROUTE_REG, NULL},

    /* Java */
    {"Spring", CTX_SVC_ROUTE_REG, NULL},
    {"jakarta.ws.rs", CTX_SVC_ROUTE_REG, NULL},

    /* C# */
    {"Microsoft.AspNetCore", CTX_SVC_ROUTE_REG, NULL},
    {"MapGet", CTX_SVC_ROUTE_REG, NULL},
    {"MapPost", CTX_SVC_ROUTE_REG, NULL},

    /* Ruby */
    {"ActionDispatch", CTX_SVC_ROUTE_REG, NULL},
    {"Sinatra", CTX_SVC_ROUTE_REG, NULL},

    /* Elixir */
    {"Phoenix.Router", CTX_SVC_ROUTE_REG, NULL},

    /* Scala */
    {"akka.http.scaladsl.server", CTX_SVC_ROUTE_REG, NULL},
    {"play.api.routing", CTX_SVC_ROUTE_REG, NULL},

    {NULL, CTX_SVC_NONE, NULL},
};

/* Method suffix type (used by both route registration and HTTP client tables) */
typedef struct {
    const char *suffix;
    const char *method;
} method_suffix_t;

/* Route registration method suffixes — matched on callee name.
 * These are methods on router objects that register handlers. */
static const method_suffix_t route_reg_suffixes[] = {
    /* HTTP method registrations */
    {".GET", "GET"},
    {".Get", "GET"},
    {".get", "GET"},
    {".POST", "POST"},
    {".Post", "POST"},
    {".post", "POST"},
    {".PUT", "PUT"},
    {".Put", "PUT"},
    {".put", "PUT"},
    {".DELETE", "DELETE"},
    {".Delete", "DELETE"},
    {".delete", "DELETE"},
    {".PATCH", "PATCH"},
    {".Patch", "PATCH"},
    {".patch", "PATCH"},
    /* Handle/HandleFunc (Go stdlib, gorilla) */
    {".Handle", "ANY"},
    {".HandleFunc", "ANY"},
    {".handle", "ANY"},
    /* Framework-specific route registration */
    {".Route", "ANY"},
    {".route", "ANY"},
    {"::get", "GET"},
    {"::post", "POST"},
    {"::put", "PUT"},
    {"::delete", "DELETE"},
    {"::patch", "PATCH"},
    /* Minimal API (C# ASP.NET) */
    {".MapGet", "GET"},
    {".MapPost", "POST"},
    {".MapPut", "PUT"},
    {".MapDelete", "DELETE"},
    /* Router mounting / prefix registration (any method) */
    {".include_router", "ANY"},
    {".mount", "ANY"},
    {".add_url_rule", "ANY"},
    {".register_blueprint", "ANY"},
    {".use", "ANY"},
    {".register", "ANY"},
    {".add_route", "ANY"},
    {".add_api_route", "ANY"},
    {".add_api_websocket_route", "ANY"},
    {NULL, NULL},
};

/* ── HTTP method inference from function/method name suffix ───── */

static const method_suffix_t method_suffixes[] = {
    {".get", "GET"},           {".Get", "GET"},           {".GET", "GET"},
    {".post", "POST"},         {".Post", "POST"},         {".POST", "POST"},
    {".put", "PUT"},           {".Put", "PUT"},           {".PUT", "PUT"},
    {".delete", "DELETE"},     {".Delete", "DELETE"},     {".DELETE", "DELETE"},
    {".patch", "PATCH"},       {".Patch", "PATCH"},       {".PATCH", "PATCH"},
    {".head", "HEAD"},         {".Head", "HEAD"},         {".HEAD", "HEAD"},
    {".options", "OPTIONS"},   {".Options", "OPTIONS"},   {"GetAsync", "GET"},
    {"PostAsync", "POST"},     {"PutAsync", "PUT"},       {"DeleteAsync", "DELETE"},
    {"SendAsync", NULL},       {"getForObject", "GET"},   {"getForEntity", "GET"},
    {"postForObject", "POST"}, {"postForEntity", "POST"}, {NULL, NULL},
};

/* ── Matching implementation ───────────────────────────────────── */

/* Check if any library identifier appears as a substring in the QN.
 * Case-sensitive: "requests" matches "project.venv.requests.api.get"
 * but not "Requests". Library names are specific enough to avoid
 * false positives even with substring matching. */
static const lib_pattern_t *match_qn(const char *qn, const lib_pattern_t *patterns) {
    if (!qn || !qn[0]) {
        return NULL;
    }
    for (int i = 0; patterns[i].library_id != NULL; i++) {
        if (strstr(qn, patterns[i].library_id) != NULL) {
            return &patterns[i];
        }
    }
    return NULL;
}

/* ── Public API ────────────────────────────────────────────────── */

void ctx_service_patterns_init(void) {
    /* No-op — tables are static const */
}

ctx_svc_kind_t ctx_service_pattern_match(const char *resolved_qn) {
    if (!resolved_qn || !resolved_qn[0]) {
        return CTX_SVC_NONE;
    }

    /* Route registration checked first — prevents gin/echo from matching
     * as HTTP clients (both have .get/.post suffixes). */
    const lib_pattern_t *p = match_qn(resolved_qn, route_reg_libraries);
    if (p) {
        return p->kind;
    }

    p = match_qn(resolved_qn, http_libraries);
    if (p) {
        return p->kind;
    }

    p = match_qn(resolved_qn, async_libraries);
    if (p) {
        return p->kind;
    }

    p = match_qn(resolved_qn, config_libraries);
    if (p) {
        return p->kind;
    }

    return CTX_SVC_NONE;
}

const char *ctx_service_pattern_http_method(const char *callee_name) {
    if (!callee_name) {
        return NULL;
    }
    for (int i = 0; method_suffixes[i].suffix != NULL; i++) {
        size_t slen = strlen(method_suffixes[i].suffix);
        size_t clen = strlen(callee_name);
        if (clen >= slen && strcmp(callee_name + clen - slen, method_suffixes[i].suffix) == 0) {
            return method_suffixes[i].method;
        }
    }
    return NULL;
}

const char *ctx_service_pattern_route_method(const char *callee_name) {
    if (!callee_name) {
        return NULL;
    }
    size_t clen = strlen(callee_name);
    for (int i = 0; route_reg_suffixes[i].suffix != NULL; i++) {
        size_t slen = strlen(route_reg_suffixes[i].suffix);
        if (clen >= slen && strcmp(callee_name + clen - slen, route_reg_suffixes[i].suffix) == 0) {
            return route_reg_suffixes[i].method;
        }
    }
    return NULL;
}

const char *ctx_service_pattern_broker(const char *resolved_qn) {
    if (!resolved_qn) {
        return NULL;
    }
    const lib_pattern_t *p = match_qn(resolved_qn, async_libraries);
    return p ? p->broker : NULL;
}
