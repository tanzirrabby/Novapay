const { NodeSDK } = require("@opentelemetry/sdk-node");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const sdk = new NodeSDK({
  serviceName: process.env.SERVICE_NAME || "fx-service",
  traceExporter: new OTLPTraceExporter({
    url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://jaeger:4318"}/v1/traces`,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();
process.on("SIGTERM", () => sdk.shutdown().finally(() => process.exit(0)));
