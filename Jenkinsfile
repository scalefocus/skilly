// skilly — Jenkins declarative pipeline: CI (lint/typecheck/test/db-test/build) + gated deploy.
//
// Mirrors .github/workflows/ci.yml and deploys via Docker remote context (no registry required).
//
// AGENT PREREQUISITES (label: linux):
//   - asdf with nodejs 20+ plugin, Docker Engine + the `docker compose` plugin, git, ssh.
//
// CONFIGURATION — this file carries NO environment-specific values. Everything the deploy needs
// lives in Jenkins credentials, so nothing host/path/URL-specific is committed to the repo. Each
// value resolves as: build parameter (per-build override) → Jenkins credential → error.
//
// JENKINS CREDENTIALS (Manage Jenkins → Credentials; set the IDs exactly as below):
//   - skilly-deploy-env      : "Secret file"                   → production deploy/.env (never in git)
//   - skilly-deploy-ssh      : "SSH Username with private key" → access to the deploy host
//   - skilly-deploy-host     : "Secret text"                   → SSH target, e.g. user@host
//   - skilly-deploy-path     : "Secret text"                   → checkout path on the deploy host
//   - skilly-deploy-git-url  : "Secret text"                   → git URL the deploy host fetches
//                                                                (the public GitHub URL, or a mirror)
//   - (optional) a "Secret text" token for an AUTHENTICATED fetch (private mirror only) — pass its
//     credential id via the DEPLOY_GIT_CREDENTIALS_ID parameter; leave unset for a public repo.
// Any DEPLOY_* build parameter, when filled in, overrides its credential for that single build.
//
// Deploy model: Docker remote context over SSH.
//   Jenkins creates a Docker context pointing at the deploy host via SSH, then runs
//   `docker compose up --build -d` through that context — images are built and run on the
//   deploy host, no registry required.

pipeline {
  agent { label params.AGENT_LABEL ?: 'linux' }

  options {
    timestamps()
    timeout(time: 60, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '30'))
  }

  parameters {
    string(name: 'AGENT_LABEL', defaultValue: 'linux', description: 'Jenkins agent label to run on')
    booleanParam(name: 'RUN_DB_TESTS', defaultValue: false, description: 'Run gated live-DB integration tests (spins an ephemeral Postgres)')
    booleanParam(name: 'DEPLOY', defaultValue: false, description: 'Force a deploy regardless of branch (main deploys automatically)')
    string(name: 'DEPLOY_HOST', defaultValue: '', description: 'SSH target, e.g. user@host. Blank = use the skilly-deploy-host credential; filled = override it for this build.')
    string(name: 'DEPLOY_PATH', defaultValue: '', description: 'Checkout path on the deploy host. Blank = use the skilly-deploy-path credential; filled = override it for this build.')
    string(name: 'DEPLOY_GIT_URL', defaultValue: '', description: 'Git URL the deploy host fetches this repo from. Blank = use the skilly-deploy-git-url credential; filled = override it for this build.')
    string(name: 'DEPLOY_GIT_CREDENTIALS_ID', defaultValue: '', description: 'Optional "Secret text" credential id: token for an authenticated fetch of DEPLOY_GIT_URL (blank = unauthenticated fetch, e.g. a public repo).')
  }

  environment {
    PNPM_VERSION    = '9.15.9'
    CI_PG_CONTAINER = "skilly-ci-pg-${env.BUILD_TAG}"
    CI_PG_PORT      = '55432'
    // DATABASE_URL used by the gated db-tests (points at the ephemeral CI Postgres).
    CI_DATABASE_URL = "postgres://skilly:test@127.0.0.1:55432/skilly"
    // asdf — must set ASDF_DIR explicitly so asdf.sh can locate itself in a non-interactive shell.
    ASDF_DIR = "${env.HOME}/.asdf"
    PATH     = "${env.HOME}/.asdf/shims:${env.HOME}/.asdf/bin:${env.PATH}"
  }

  stages {
    stage('Toolchain') {
      steps {
        sh '''
          set -eu
          # Activate asdf and install the Node version declared in .tool-versions (or latest 20).
          . "${HOME}/.asdf/asdf.sh"
          asdf plugin add nodejs || true
          asdf install nodejs   # reads .tool-versions; falls back gracefully if already installed
          # Install pnpm via corepack (bundled with Node 16.9+).
          corepack enable
          corepack prepare "pnpm@${PNPM_VERSION}" --activate
          asdf reshim nodejs
          node -v && pnpm -v && docker --context default version --format '{{.Server.Version}}'
        '''
      }
    }

    stage('Install') {
      steps {
        sh '. "${HOME}/.asdf/asdf.sh" && pnpm install --frozen-lockfile'
      }
    }

    stage('Build packages') {
      // shared must build before web/worker can resolve @skilly/shared types.
      steps {
        sh '. "${HOME}/.asdf/asdf.sh" && pnpm -r build'
      }
    }

    stage('Typecheck') {
      steps {
        sh '. "${HOME}/.asdf/asdf.sh" && pnpm -r typecheck'
      }
    }

    stage('Unit tests') {
      // Live-DB suites self-skip when SKILLY_DB_E2E is unset, so this stays hermetic.
      steps {
        sh '. "${HOME}/.asdf/asdf.sh" && pnpm -r test'
      }
    }

    stage('DB integration tests') {
      when { expression { return params.RUN_DB_TESTS } }
      steps {
        sh '''
          set -eu
          . "${HOME}/.asdf/asdf.sh"

          # Ephemeral Postgres for the gated suites.
          docker run -d --rm --name "${CI_PG_CONTAINER}" \
            -e POSTGRES_USER=skilly -e POSTGRES_PASSWORD=test -e POSTGRES_DB=skilly \
            -p ${CI_PG_PORT}:5432 postgres:16-alpine

          # Wait for readiness.
          for i in $(seq 1 30); do
            if docker exec "${CI_PG_CONTAINER}" pg_isready -U skilly >/dev/null 2>&1; then break; fi
            sleep 2
          done

          # Create least-privilege app role and apply all migrations.
          docker exec "${CI_PG_CONTAINER}" psql -U skilly -d skilly -c \
            "DO \\$\\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='skilly_app') THEN CREATE ROLE skilly_app LOGIN PASSWORD 'test'; END IF; END \\$\\$;"
          for f in db/migrations/*.sql; do
            echo "applying $f"
            docker exec -i "${CI_PG_CONTAINER}" psql -U skilly -d skilly -v ON_ERROR_STOP=1 < "$f"
          done

          # Worker integration flow (publish/mirror) + web DB tests.
          SKILLY_DB_E2E=1 DATABASE_URL="${CI_DATABASE_URL}" \
            node --test "packages/worker/dist/integration/publishFlow.test.js"
          SKILLY_DB_E2E=1 DATABASE_URL="${CI_DATABASE_URL}" \
            pnpm --filter @skilly/web test:db
        '''
      }
      post {
        always {
          sh 'docker rm -f "${CI_PG_CONTAINER}" >/dev/null 2>&1 || true'
        }
      }
    }

    stage('Deploy') {
      when {
        anyOf {
          branch 'main'
          expression { return params.DEPLOY }
        }
      }
      steps {
        script {
          // Deploy config resolves as: build parameter (per-build override) → Jenkins credential.
          // Host/path/git-url are held in "Secret text" credentials so they persist across runs
          // (unlike parameter defaults, which Jenkins re-syncs from this file) and stay out of git.
          withCredentials([
            file(credentialsId: 'skilly-deploy-env', variable: 'DEPLOY_ENV_FILE'),
            sshUserPrivateKey(credentialsId: 'skilly-deploy-ssh', keyFileVariable: 'SSH_KEY', usernameVariable: 'SSH_USER'),
            string(credentialsId: 'skilly-deploy-host', variable: 'DEPLOY_HOST_CRED'),
            string(credentialsId: 'skilly-deploy-path', variable: 'DEPLOY_PATH_CRED'),
            string(credentialsId: 'skilly-deploy-git-url', variable: 'DEPLOY_GIT_URL_CRED')
          ]) {
            def deployHost   = params.DEPLOY_HOST?.trim()    ?: env.DEPLOY_HOST_CRED
            def deployPath   = params.DEPLOY_PATH?.trim()    ?: env.DEPLOY_PATH_CRED
            def deployGitUrl = params.DEPLOY_GIT_URL?.trim() ?: env.DEPLOY_GIT_URL_CRED
            [DEPLOY_HOST: deployHost, DEPLOY_PATH: deployPath, DEPLOY_GIT_URL: deployGitUrl].each { name, value ->
              if (!value?.trim()) {
                error "${name} is empty — set its Jenkins credential (skilly-deploy-*) or pass the matching build parameter."
              }
            }
            withEnv(["DEPLOY_HOST=${deployHost}", "DEPLOY_PATH=${deployPath}", "DEPLOY_GIT_URL=${deployGitUrl}"]) {
              // ── 1. Fast-forward the repo on the deploy host to this exact commit ──────────
              //    The fetch URL is assembled by the SHELL (single-quoted Groovy string, no Groovy
              //    interpolation): the optional token expands from a masked credential env var, so it
              //    never appears in the build log or in this file. A shell case (not sed) splices the
              //    token, so a token containing sed metacharacters can't corrupt the URL.
              def fetchStep = '''
                set -eu
                SSH="ssh -i ${SSH_KEY} -o StrictHostKeyChecking=accept-new"
                FETCH_URL="${DEPLOY_GIT_URL}"
                if [ -n "${DEPLOY_GIT_TOKEN:-}" ]; then
                  case "${DEPLOY_GIT_URL}" in
                    https://*) FETCH_URL="https://x-access-token:${DEPLOY_GIT_TOKEN}@${DEPLOY_GIT_URL#https://}" ;;
                    *) echo "a deploy git token is set but DEPLOY_GIT_URL is not https:// — refusing to attach the token" >&2; exit 1 ;;
                  esac
                fi
                $SSH "${DEPLOY_HOST}" "cd ${DEPLOY_PATH} && git fetch ${FETCH_URL} --prune && git checkout --detach ${GIT_COMMIT}"
              '''
              if (params.DEPLOY_GIT_CREDENTIALS_ID?.trim()) {
                withCredentials([string(credentialsId: params.DEPLOY_GIT_CREDENTIALS_ID, variable: 'DEPLOY_GIT_TOKEN')]) {
                  sh fetchStep
                }
              } else {
                sh fetchStep
              }
              sh '''
                set -eu
                SSH="ssh -i ${SSH_KEY} -o StrictHostKeyChecking=accept-new"
                SCP="scp -i ${SSH_KEY} -o StrictHostKeyChecking=accept-new"

                # ── 2. Push the secret .env to the deploy host (never in git) ─────────────────
                $SCP "${DEPLOY_ENV_FILE}" "${DEPLOY_HOST}:${DEPLOY_PATH}/deploy/.env"

                # ── 3. Build images and (re)start the stack on the remote host ─────────────────
                #       SSH into the target and run docker compose there directly.
                $SSH "${DEPLOY_HOST}" "cd ${DEPLOY_PATH}/deploy && docker compose up --build -d"

                # ── 4. Ensure the MinIO artifact bucket exists (idempotent) ──────────────────
                #    Write script locally (single-quoted heredoc = no local expansion),
                #    substitute the deploy path, SCP to remote, execute, clean up.
                cat > /tmp/_skilly_minio.sh << 'MINIO_SCRIPT'
#!/bin/sh
set -e
cd __DEPLOY_PATH__/deploy
set -a; . ./.env; set +a
docker compose exec -T minio sh -c 'mc alias set s3 http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc mb -p s3/${S3_BUCKET:-skilly-artifacts}'
MINIO_SCRIPT
                sed -i "s|__DEPLOY_PATH__|${DEPLOY_PATH}|g" /tmp/_skilly_minio.sh
                $SCP /tmp/_skilly_minio.sh "${DEPLOY_HOST}:/tmp/_skilly_minio.sh"
                $SSH "${DEPLOY_HOST}" "sh /tmp/_skilly_minio.sh; rm -f /tmp/_skilly_minio.sh" || true
                rm -f /tmp/_skilly_minio.sh

                # ── 5. Smoke-check readiness ──────────────────────────────────────────────────
                $SSH "${DEPLOY_HOST}" 'for i in $(seq 1 30); do curl -fsS http://localhost:8080/readyz && break || sleep 3; done'
              '''
            } // withEnv
          } // withCredentials
        }
      }
    }
  }

  post {
    always {
      sh 'docker rm -f "${CI_PG_CONTAINER}" >/dev/null 2>&1 || true'
    }
    success { echo "skilly pipeline OK — ${env.GIT_COMMIT}" }
    failure { echo "skilly pipeline FAILED — ${env.GIT_COMMIT}" }
  }
}

// ── Notes ─────────────────────────────────────────────────────────────────────────────────────
//  - Docker remote context (current): Jenkins connects to the deploy host via SSH and runs
//    `docker compose up --build -d` there. No registry needed; images are built on the target.
//  - Registry-based upgrade path: tag + push images in a "Push images" stage, add `image:` fields
//    to docker-compose.yml, and replace the compose call with `docker compose pull && up -d`.
//  - Kubernetes: swap the Deploy stage for
//    `helm upgrade --install skilly deploy/helm/skilly --set image.tag=${GIT_COMMIT}`.
//  - Secrets: deploy/.env must NEVER be committed; injected via the `skilly-deploy-env` credential.
//    SKILLY_DEV_AUTH must never be set in production.
