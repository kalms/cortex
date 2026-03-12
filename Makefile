.PHONY: build test lint clean install check bench-memory

BINARY=codebase-memory-mcp
MODULE=github.com/DeusData/codebase-memory-mcp

build:
	go build -o bin/$(BINARY) ./cmd/codebase-memory-mcp/

test:
	go test ./... -v

check: lint test  ## Run lint + tests

lint:  ## Run golangci-lint
	golangci-lint run --timeout=5m ./...

clean:
	rm -rf bin/

install:
	go install ./cmd/codebase-memory-mcp/

bench-memory:  ## Run memory stability benchmark
	go test -run TestMemoryStability -v -count=1 -timeout=5m ./internal/pipeline/
