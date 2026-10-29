# builds the branch server. the build context is the repo root (railway.json sets this up),
# because the admin panel reuses files from app/ui/shared.

FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY server ./server
COPY app/ui/shared ./app/ui/shared
RUN cd server && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home branch
COPY --from=build /src/server/target/release/branch-server /usr/local/bin/branch-server
USER branch
ENV RUST_LOG=info
CMD ["branch-server"]
