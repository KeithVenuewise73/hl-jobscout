# Deno rather than Node because the rest of this repo is Deno, and because the
# whole app is two files with no dependencies to install.
FROM denoland/deno:alpine-2.1.4

WORKDIR /app
COPY relay.ts main.ts ./

# Compile ahead of time so a syntax error fails the BUILD rather than the first
# page load.
RUN deno check main.ts

USER deno
EXPOSE 8000
CMD ["deno", "run", "--allow-net", "--allow-env", "main.ts"]
