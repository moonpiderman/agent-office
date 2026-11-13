# 데스크톱 앱 배포

Agent Office 데스크톱 앱은 Electron Forge로 macOS용 DMG와 ZIP을 만듭니다. 버전 결정과 최종 공개는 사람이 하고, 검증·빌드·GitHub Release 초안 생성은 GitHub Actions가 담당합니다.

## 버전 정책

[Semantic Versioning](https://semver.org/)을 따릅니다. `1.0.0` 이전에는 다음 기준으로 버전을 올립니다.

| 변경 | 버전 | 예시 |
|---|---|---|
| 버그 수정, 아이콘·문구 개선 | PATCH | `0.1.1` → `0.1.2` |
| 사용자에게 보이는 기능 추가 | MINOR | `0.1.1` → `0.2.0` |
| 호환성이 깨지는 변경 | MINOR | `0.2.0` → `0.3.0` |
| 공개 계약이 안정된 이후의 호환성 파괴 | MAJOR | `1.2.0` → `2.0.0` |

시험 배포는 `v0.2.0-beta.1` 또는 `v0.2.0-rc.1` 형식의 태그를 사용합니다. 정식 배포는 `v0.2.0` 형식입니다.

## 릴리스 채널

| 태그 | GitHub Release |
|---|---|
| `vX.Y.Z-beta.N` | Draft + Prerelease |
| `vX.Y.Z-rc.N` | Draft + Prerelease |
| `vX.Y.Z` | Draft |

모든 새 Release는 초안으로 생성됩니다. 설치 파일을 확인한 뒤 GitHub에서 직접 Publish합니다.

## 브랜치 전략

`main`은 마지막으로 공개한 버전의 기준이고, `develop`은 다음 기능 릴리스를 통합하는 브랜치입니다. 둘 다 PR과 `validate-macos` CI를 통과해야 변경할 수 있습니다.

| 변경 | PR 경로 | 버전 결정 |
|---|---|---|
| 새 기능·일반 수정 | `feature/* → develop` | 변경 없음 |
| 다음 기능 묶음 출시 | `develop → main` | 릴리스 PR에서 MINOR 지정 |
| 공개 버전 긴급 수정 | `hotfix/* → main` | 릴리스 PR에서 PATCH 지정 |
| 호환성을 깨는 출시 | `develop → main` | 개발자가 MAJOR 지정 |

`develop`에 기능을 병합할 때마다 버전을 올리지 않습니다. 출시할 변경이 모이면 `develop`에서 `package.json`과 `package-lock.json`을 다음 버전으로 바꾸고, 그 커밋을 포함한 PR을 `main`에 병합합니다. 핫픽스가 `main`에 병합된 후에는 `main → develop` PR을 열어 수정과 버전을 다시 동기화합니다.

## PR 검증

`main`과 `develop` 대상 PR, 두 브랜치의 푸시에서 다음 검증을 수행합니다.

1. 의존성을 lockfile 기준으로 설치
2. 주요 JavaScript 파일 구문 검사
3. 앱 아이콘 재생성 결과가 커밋된 자산과 같은지 검사
4. Apple Silicon용 데스크톱 앱 패키징

두 브랜치 모두 `validate-macos`를 필수 상태 검사로 지정합니다.

## 로컬 확인

```bash
npm ci
npm run check
npm run icon:build
npm run package:desktop
npm run make
```

`npm run make` 결과는 `out/make`에 생성됩니다. DMG는 macOS에서만 만들 수 있습니다.

## 릴리스 만들기

1. 기능 PR들을 `develop`에 병합합니다.
2. `develop`에서 릴리스 브랜치를 만들고, 출시할 버전을 결정해 `package.json`과 `package-lock.json`을 갱신한 뒤 `develop`에 PR로 병합합니다.
3. `develop → main` PR의 CI가 성공하면 병합합니다.
4. 병합된 `main` 커밋에 같은 버전의 annotated tag를 만들고 푸시합니다.

예를 들어 `0.2.0`을 배포하려면 다음과 같이 실행합니다.

```bash
git switch develop
git pull --ff-only
git switch -c release/v0.2.0
npm version 0.2.0 --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: prepare v0.2.0"
git push -u origin release/v0.2.0
# release/v0.2.0 → develop PR을 병합한 다음 develop → main PR을 병합
git switch main
git pull --ff-only
git tag -a v0.2.0 -m "Agent Office v0.2.0"
git push origin v0.2.0
```

워크플로는 아래 조건을 모두 확인합니다.

- 태그와 `package.json` 버전이 일치함
- 태그가 `vX.Y.Z`, `vX.Y.Z-beta.N`, `vX.Y.Z-rc.N` 중 하나임
- 태그가 가리키는 커밋이 `origin/main`에 포함됨
- arm64/x64용 DMG와 ZIP이 각각 하나씩 생성됨

완성된 파일 이름은 다음과 같습니다.

```text
Agent-Office-0.2.0-macos-arm64.dmg
Agent-Office-0.2.0-macos-arm64.zip
Agent-Office-0.2.0-macos-x64.dmg
Agent-Office-0.2.0-macos-x64.zip
SHA256SUMS.txt
```

실패한 릴리스는 GitHub Actions의 `Release desktop app`에서 기존 태그를 입력해 다시 실행할 수 있습니다. 기존 Release가 있으면 자산만 교체하며, 공개 상태는 바꾸지 않습니다.

## 선택 사항: 서명과 notarization

현재는 서명 정보 없이도 정식 릴리스를 만들 수 있습니다. 이 경우 다른 Mac에서 Gatekeeper 경고가 나타날 수 있습니다. 나중에 서명 배포가 필요해지면 다음 Actions secret을 등록합니다.

| Secret | 내용 |
|---|---|
| `MACOS_CERTIFICATE` | Developer ID Application `.p12` 파일의 base64 문자열 |
| `MACOS_CERTIFICATE_PASSWORD` | `.p12` 내보내기 암호 |
| `APPLE_ID` | Apple Developer 계정 이메일 |
| `APPLE_ID_PASSWORD` | Apple ID 앱 전용 암호 |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

값이 등록되어 있으면 워크플로가 코드 서명과 notarization을 자동으로 적용합니다. 릴리스에 필수인 설정은 아닙니다.

## Release 공개 전 확인

- 두 아키텍처의 DMG 또는 ZIP이 모두 첨부됐는지 확인
- `SHA256SUMS.txt`가 네 설치 파일을 모두 포함하는지 확인
- Apple Silicon과 Intel 중 가능한 환경에서 앱 실행 확인
- Release 노트 상단에 주요 변경, 설치 방법, 알려진 문제 작성
- Prerelease 또는 정식 Release 표시가 올바른지 확인
- 확인이 끝나면 Draft를 Publish

GitHub Release는 다운로드 배포만 담당합니다. 인앱 자동 업데이트를 추가할 때는 별도의 업데이트 피드와 stable/beta 채널 정책을 설계해야 합니다.
