FROM ubuntu:24.04

ARG RUNNER_VERSION=2.336.0
ARG RUNNER_SHA256=04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/runner \
    RUNNER_TOOL_CACHE=/opt/hostedtoolcache

RUN chmod 1777 /tmp \
    && apt-get update \
    && apt-get install --no-install-recommends --yes \
        bash \
        build-essential \
        ca-certificates \
        curl \
        docker.io \
        docker-compose-v2 \
        file \
        git \
        gnupg \
        gh \
        jq \
        libgtk-3-dev \
        libicu-dev \
        libssl-dev \
        pkg-config \
        python3 \
        python3-venv \
        ruby \
        ruby-dev \
        skopeo \
        sudo \
        unzip \
        xz-utils \
        zlib1g \
        zstd \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1001 --create-home --home-dir /home/runner --shell /bin/bash runner \
    && mkdir -p /opt/actions-runner /opt/hostedtoolcache /runner \
    && curl --fail --location --show-error \
        --output /tmp/actions-runner.tar.gz \
        "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    && echo "${RUNNER_SHA256}  /tmp/actions-runner.tar.gz" | sha256sum --check --strict \
    && tar --extract --gzip --file /tmp/actions-runner.tar.gz --directory /opt/actions-runner \
    && rm /tmp/actions-runner.tar.gz \
    && chown -R runner:runner /opt/actions-runner /opt/hostedtoolcache /runner \
    && printf 'runner ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/runner \
    && chmod 0440 /etc/sudoers.d/runner

COPY --chown=runner:runner entrypoint.sh /usr/local/bin/multivibe-actions-runner-entrypoint
RUN chmod 0755 /usr/local/bin/multivibe-actions-runner-entrypoint

WORKDIR /runner
USER runner
ENTRYPOINT ["/usr/local/bin/multivibe-actions-runner-entrypoint"]
