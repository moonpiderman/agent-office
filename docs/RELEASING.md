# 데스크톱 앱 배포

Agent Office 데스크톱 앱은 Electron Forge로 macOS용 DMG와 ZIP을 만듭니다. 태그를 푸시하면 GitHub Actions가 Apple Silicon과 Intel 패키지를 빌드하고 GitHub Release에 첨부합니다.

## 로컬 확인

```bash
npm ci
npm run desktop
npm run make
```

`npm run make`의 결과는 `out/make`에 생성됩니다. DMG는 macOS에서만 만들 수 있습니다.

## 릴리스 만들기

1. `package.json`의 `version`을 올리고 변경을 main에 반영합니다.
2. 같은 버전으로 태그를 만들고 푸시합니다.

```bash
git tag v0.1.0
git push origin v0.1.0
```

태그와 `package.json` 버전이 다르면 워크플로가 중단됩니다. 실패한 릴리스는 GitHub Actions의 `Release desktop app`에서 기존 태그를 입력해 다시 실행할 수 있습니다.

## 서명과 notarization

서명 정보가 없는 경우에도 패키지는 만들어지지만 다른 Mac에서 Gatekeeper 경고가 나타납니다. 공개 배포 전에 저장소의 Actions secrets에 다음 값을 등록합니다.

| Secret | 내용 |
|---|---|
| `MACOS_CERTIFICATE` | Developer ID Application `.p12` 파일의 base64 문자열 |
| `MACOS_CERTIFICATE_PASSWORD` | `.p12` 내보내기 암호 |
| `APPLE_ID` | Apple Developer 계정 이메일 |
| `APPLE_ID_PASSWORD` | Apple ID 앱 전용 암호 |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

인증서가 등록되면 코드 서명을 적용하고, Apple 계정 세 값도 모두 등록되면 notarization까지 수행합니다.
