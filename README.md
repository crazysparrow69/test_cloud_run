# Проверка деплоя на Cloud Run

Чеклист человека. Команды копируются целиком. В каждой команде замените `PROJECT_ID` на id нового проекта. Настоящий id в файлы репозитория не подставлять: `cloudbuild.yaml` берёт `$PROJECT_ID` и `$COMMIT_SHA` из Cloud Build.

Регион везде `europe-west1`. Не использовать `europe-central2` и другие регионы Tier 2.

## 1. Убрать sleepr с того же billing-аккаунта

Кластер GKE sleepr должен быть удалён. Репозитории образов sleepr в Artifact Registry на этом аккаунте тоже удалить: бесплатные 0,5 ГБ общие на аккаунт.

`SLEEPR_PROJECT_ID` — проект, где лежал sleepr. `CLUSTER_NAME`, `ZONE`, `REPO` и `LOCATION` взять из вывода команд списка.

```bash
gcloud container clusters list --project=SLEEPR_PROJECT_ID
gcloud container clusters delete CLUSTER_NAME --zone=ZONE --project=SLEEPR_PROJECT_ID --quiet
gcloud compute forwarding-rules list --project=SLEEPR_PROJECT_ID
gcloud artifacts repositories list --project=SLEEPR_PROJECT_ID
gcloud artifacts repositories delete REPO --location=LOCATION --project=SLEEPR_PROJECT_ID --quiet
```

Пустой список кластеров и пустой список forwarding-rules — то, что нужно. Если forwarding-rule остался после удаления кластера, удалить его отдельно: это балансировщик, он тарифицируется, пока существует.

## 2. Создать проект

```bash
gcloud projects create PROJECT_ID --name=deploy-proof
gcloud config set project PROJECT_ID
```

## 3. Привязать billing и выйти из Free Trial

`BILLING_ACCOUNT_ID` — id из списка аккаунтов, тот же, что у sleepr.

```bash
gcloud billing accounts list
gcloud billing projects link PROJECT_ID --billing-account=BILLING_ACCOUNT_ID
gcloud billing projects describe PROJECT_ID
```

В консоли биллинга проверить, что аккаунт активен и карта привязана. Если аккаунт всё ещё Free Trial, перевести его в платный до первого деплоя. Иначе по окончании trial Google остановит сервис.

Бюджет ниже только предупреждает. Он не останавливает ресурсы.

## 4. Бюджет $5 на этот проект

```bash
gcloud services enable billingbudgets.googleapis.com --project=PROJECT_ID
gcloud billing budgets create \
  --billing-account=BILLING_ACCOUNT_ID \
  --display-name="deploy-proof 5 USD" \
  --budget-amount=5USD \
  --calendar-period=month \
  --filter-projects=projects/PROJECT_ID \
  --threshold-rule=percent=1.0
```

Письмо придёт на $5 фактических расходов по проекту. Это страховка на случай чужого региона или always-on флага, не замена флагов в `cloudbuild.yaml`.

## 5. Включить API

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  --project=PROJECT_ID
```

Container Scanning и другие API не включать.

## 6. Репозиторий образов

Сканирование уязвимостей выключено: это отдельная платная услуга, не бесплатный Artifact Registry.

```bash
gcloud artifacts repositories create deploy-proof \
  --repository-format=docker \
  --location=europe-west1 \
  --description="Cloud Run deploy proof" \
  --disable-vulnerability-scanning \
  --project=PROJECT_ID
```

## 7. Хранить 3 последние версии

Политика удаления без политики хранения сотрёт все версии. Здесь удаляются версии старше одной секунды, кроме трёх самых новых. Фоновая очистка применяется примерно в течение суток. Теги оставлять изменяемыми: при неизменяемых тегах помеченные версии не удаляются.

```bash
cat > /tmp/deploy-proof-cleanup.json <<'EOF'
[
  {
    "name": "delete-old",
    "action": {"type": "Delete"},
    "condition": {
      "tagState": "any",
      "olderThan": "1s"
    }
  },
  {
    "name": "keep-3",
    "action": {"type": "Keep"},
    "mostRecentVersions": {
      "keepCount": 3
    }
  }
]
EOF
gcloud artifacts repositories set-cleanup-policies deploy-proof \
  --location=europe-west1 \
  --project=PROJECT_ID \
  --policy=/tmp/deploy-proof-cleanup.json \
  --no-dry-run
```

## 8. Подключить GitHub к Cloud Build

Подключение первого поколения, через приложение Cloud Build GitHub App. Второе поколение не использовать: оно хранит токен GitHub в Secret Manager.

Это делается в браузере. Открыть [Cloud Build → Triggers → Connect repository](https://console.cloud.google.com/cloud-build/triggers;region=global/connect?project=PROJECT_ID):

1. Region: `global`.
2. Source: `GitHub (Cloud Build GitHub App)`.
3. Войти в GitHub и установить приложение Google Cloud Build только на этот репозиторий, не на все.
4. Выбрать репозиторий, отметить согласие, нажать Connect.
5. Шаг создания триггера в мастере пропустить: триггер создаётся командой ниже.

## 9. Роли аккаунта сборки и триггер на `main`

Адрес аккаунта не угадывать: посмотреть аккаунт по умолчанию и явно указать его в триггере. В новом проекте это compute-аккаунт `PROJECT_NUMBER-compute@developer.gserviceaccount.com`. Если команда напечатала другой email, подставить в `BUILD_SERVICE_ACCOUNT` его.

```bash
gcloud builds get-default-service-account \
  --region=global \
  --project=PROJECT_ID \
  --format='value(serviceAccountEmail)'
```

Подставить email в `BUILD_SERVICE_ACCOUNT`. Ему нужны запись в Artifact Registry, деплой Cloud Run и запись логов: без Logs Writer сборка от аккаунта триггера падает, потому что в `cloudbuild.yaml` логи идут только в Cloud Logging. `roles/iam.serviceAccountUser` выдаётся не на проект, а на runtime-аккаунт Cloud Run. Отдельный runtime-аккаунт деплой не задаёт, поэтому это стандартный compute-аккаунт проекта.

```bash
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:BUILD_SERVICE_ACCOUNT" \
  --role="roles/artifactregistry.writer"
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:BUILD_SERVICE_ACCOUNT" \
  --role="roles/run.admin"
gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:BUILD_SERVICE_ACCOUNT" \
  --role="roles/logging.logWriter"
PROJECT_NUMBER="$(gcloud projects describe PROJECT_ID --format='value(projectNumber)')"
gcloud iam service-accounts add-iam-policy-binding \
  "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --member="serviceAccount:BUILD_SERVICE_ACCOUNT" \
  --role="roles/iam.serviceAccountUser" \
  --project=PROJECT_ID
```

Триггер на пуш в `main`. `GITHUB_OWNER` и `GITHUB_REPO` — владелец и имя репозитория на GitHub.

```bash
gcloud builds triggers create github \
  --name=deploy-proof-main \
  --region=global \
  --repo-owner=GITHUB_OWNER \
  --repo-name=GITHUB_REPO \
  --branch-pattern='^main$' \
  --build-config=cloudbuild.yaml \
  --service-account="projects/PROJECT_ID/serviceAccounts/BUILD_SERVICE_ACCOUNT" \
  --project=PROJECT_ID
gcloud builds triggers describe deploy-proof-main \
  --region=global \
  --project=PROJECT_ID \
  --format='yaml(name,github,filename,serviceAccount)'
```

Отдельный триггер на pull request не создавать. Ветка, отличная от `main`, сервис не выкладывает.

## 10. Первый пуш

Пуш делать после того, как триггер и роли уже есть. Иначе сборка не стартует.

```bash
git add Dockerfile .dockerignore server.js cloudbuild.yaml README.md
git commit -m "Add Cloud Run deploy proof"
git push origin main
gcloud builds list --region=global --project=PROJECT_ID --limit=5
```

Дождаться зелёной сборки. Открыть URL:

```bash
curl -sS -D - "$(gcloud run services describe deploy-proof --region=europe-west1 --project=PROJECT_ID --format='value(status.url)')"
```

Ответ: статус `200`, тело `ok`, заголовок `Content-Type: text/plain`.

Проверить флаги сервиса: регион `europe-west1`, минимум экземпляров `0`, максимум `2`, CPU `1`, память `512Mi`.

```bash
gcloud run services describe deploy-proof \
  --region=europe-west1 \
  --project=PROJECT_ID \
  --format='yaml(metadata.labels, spec.template.metadata.annotations, spec.template.spec.containers)'
```

В этом проекте не должно быть кластера, балансировщика и VPC connector. Пустой вывод у первых двух команд — норма. Третья команда может завершиться ошибкой отключённого API: connector тогда тоже нет.

```bash
gcloud container clusters list --project=PROJECT_ID
gcloud compute forwarding-rules list --project=PROJECT_ID
gcloud compute networks vpc-access connectors list --region=europe-west1 --project=PROJECT_ID
```

Если ревизия не стартует из-за доступа Cloud Run к образу, выдать чтение сервисному агенту Cloud Run и дождаться следующей сборки:

```bash
PROJECT_NUMBER="$(gcloud projects describe PROJECT_ID --format='value(projectNumber)')"
gcloud artifacts repositories add-iam-policy-binding deploy-proof \
  --location=europe-west1 \
  --project=PROJECT_ID \
  --member="serviceAccount:service-${PROJECT_NUMBER}@serverless-robot-prod.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.reader"
```

## 11. Второй пуш

Ответ `GET /` не менять. В конец `server.js` добавить строку:

```javascript
// deploy proof: second revision
```

```bash
git add server.js
git commit -m "Mark the second Cloud Run revision"
git push origin main
```

После зелёной сборки в списке две ревизии, у новой 100% трафика. URL снова отвечает `ok`. Тег образа — полный SHA коммита, не `latest` и не `production`.

```bash
gcloud run revisions list --service=deploy-proof --region=europe-west1 --project=PROJECT_ID
gcloud artifacts docker images list europe-west1-docker.pkg.dev/PROJECT_ID/deploy-proof/deploy-proof --include-tags
curl -sS -D - "$(gcloud run services describe deploy-proof --region=europe-west1 --project=PROJECT_ID --format='value(status.url)')"
```

## На следующий день

В отчёте биллинга, отфильтрованном по `PROJECT_ID`, строки Cloud Run, Cloud Build и Artifact Registry закрыты скидкой free tier. Итог по проекту $0. В отчёте нет SKU Варшавы, GKE, load balancer и idle min instance.

Если URL уже отвечает `ok`, а строка биллинга за сегодня пустая, проверка не провалена: деньги смотреть на следующий день. Сумма к оплате больше нуля — проверка не пройдена. Причина в регионе, во флаге always-on, в чужих ресурсах на том же аккаунте или в хранилище образов.
