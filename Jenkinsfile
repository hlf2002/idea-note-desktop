/*
 * 灵感笔记桌面端 —— Jenkins 多平台安装包构建流水线
 *
 * Jenkins 侧配置（New Item -> Pipeline）：
 *   Definition : Pipeline script from SCM
 *   SCM        : Git -> https://github.com/hlf2002/idea-note-desktop.git（main 分支）
 *   Script Path: Jenkinsfile
 *
 * 构建节点要求（Manage Jenkins -> Nodes，按标签挂到对应机器）：
 *   - 标签 windows：Windows 10/11 或 Server，Node.js >= 21、Git
 *   - 标签 macos  ：macOS，Node.js >= 21、Git（npm test 依赖运行器展开 glob）
 *
 * 行为说明：
 *   - mac：走 npm run package 完整链路（测试 → electron-builder → dmg 就地签名/公证/装订
 *     → 命名收尾（dmg 保留中文名、zip/blockmap 转 ASCII）→ 清单 sha512 校验）。
 *     NOTARIZE=true 时需凭据 apple-id（Apple ID + 应用专用密码）
 *     且节点上要有 Developer ID 证书；APPLE_TEAM_ID 由参数传入（公证必填，非秘密）。
 *   - win：默认不签名（finalize-win 显式接受并记录 SmartScreen 拦截后果）；在参数 WIN_SIGN_SHA1
 *     填证书存储指纹即走 Authenticode 签名 + RFC3161 时间戳，并由 finalize-win.js 做产物级校验
 *     （清单存在/版本一致/sha512 配对/PE 载荷架构/签名状态）。
 *   - ELECTRON_MIRROR 指向国内镜像，避免 CI 机器下载 Electron 二进制超时。
 *   - 单元测试用 node --test 自动发现（跨平台，无 glob 依赖）。
 */

pipeline {
    agent none

    options {
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20', artifactNumToKeepStr: '10'))
    }

    parameters {
        choice(name: 'TARGET', choices: ['all', 'win', 'mac'], description: '目标平台安装包')
        booleanParam(name: 'RUN_TESTS', defaultValue: true, description: '打包前先跑单元测试')
        booleanParam(name: 'NOTARIZE', defaultValue: false, description: 'mac 构建是否做 Apple 公证（需节点有 Developer ID 证书 + apple-id 凭据）')
        string(name: 'APPLE_TEAM_ID', defaultValue: 'FY4X5PTS6Q', description: 'Apple Developer Team ID（公证必填，非秘密）')
        string(name: 'WIN_SIGN_SHA1', defaultValue: '', description: 'Windows 代码签名证书 SHA1 指纹（留空 = 自动发现：证书存储唯一可用证书即 SimplySign 登录后自动签名）')
        string(name: 'WIN_PUBLISHER_NAME', defaultValue: '', description: 'signtool publisherName（可选，仅显式模式使用；自动模式由 electron-builder 取证书 commonName。值不得含空格）')
        booleanParam(name: 'WIN_ALLOW_UNSIGNED', defaultValue: false, description: '证书不可用时仍继续出未签名包（SmartScreen 会拦截）')
    }

    environment {
        CI = 'true'
        ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
        WIN_TIMESTAMP_URL = 'http://timestamp.digicert.com'
        // 注意：CSC_IDENTITY_AUTO_DISCOVERY 不在此处全局关闭 —— 它会让 mac 永远发现不到证书。
        // 各阶段按需覆盖：mac 阶段 NOTARIZE=false 时显式 false（无证书节点不报错），
        // NOTARIZE=true 时置 true，让 electron-builder 去钥匙串找 Developer ID。
    }

    stages {
        stage('Windows 安装包（NSIS + zip，SimplySign 自动签名）') {
            when { expression { params.TARGET == 'all' || params.TARGET == 'win' } }
            agent { label 'windows' }
            steps {
                bat 'node -v && npm -v'
                bat 'npm ci --no-audit --no-fund'
                script {
                    if (params.RUN_TESTS) {
                        bat 'npm test'
                    }
                    // win-sign.js 统一入口：显式参数 > 环境变量 > .electron-release.json >
                    // package.json > 证书存储自动发现（SimplySign 登录后唯一可用证书即自动签名，
                    // 并先做 PIN 预热防止卡在 Submitting digest）。未登录/多证书默认停止，
                    // WIN_ALLOW_UNSIGNED=true 显式放行未签名包。
                    withEnv(["WIN_SIGN_SHA1=${params.WIN_SIGN_SHA1 ?: ''}",
                             "WIN_PUBLISHER_NAME=${params.WIN_PUBLISHER_NAME ?: ''}"]) {
                        def flags = params.WIN_ALLOW_UNSIGNED ? ' --allow-unsigned' : ''
                        bat "node scripts/win-sign.js${flags}"
                    }
                }
            }
            post {
                always {
                    archiveArtifacts(
                        artifacts: 'dist/package-win/*',
                        allowEmptyArchive: true,
                        fingerprint: true
                    )
                }
            }
        }

        stage('macOS 安装包（dmg + zip，arm64/x64）') {
            when { expression { params.TARGET == 'all' || params.TARGET == 'mac' } }
            agent { label 'macos' }
            steps {
                sh 'node -v && npm -v'
                sh 'npm ci --no-audit --no-fund'
                script {
                    def skipTests = params.RUN_TESTS ? '' : 'SKIP_TESTS=1 '
                    // NOTARIZE 决定「要不要签名 + 公证」：关闭时显式停用身份自动发现，
                    // 无证书节点也能出未签名包；开启时必须让 electron-builder 能找到证书，
                    // 并且 APPLE_TEAM_ID 要与 APPLE_ID / 专用密码一起给（缺一个 builder 直接抛配置错）。
                    def needSign = params.NOTARIZE
                    withEnv(["CSC_IDENTITY_AUTO_DISCOVERY=${needSign ? 'true' : 'false'}",
                             "APPLE_TEAM_ID=${params.APPLE_TEAM_ID}"]) {
                        if (params.NOTARIZE) {
                            withCredentials([usernamePassword(
                                credentialsId: 'apple-id',
                                usernameVariable: 'APPLE_ID',
                                passwordVariable: 'APPLE_APP_SPECIFIC_PASSWORD'
                            )]) {
                                // npm run package 内部已在 stage 之前就地对 dist/*.dmg 完成
                                // 签名 + 公证 + 装订，复制进 dist/package 的就是最终字节
                                sh "${skipTests}npm run package"
                                // 幂等复核：已有票全跳过，只补缺票的包并按实际字节重算清单。
                                // 必须留在 withCredentials 内 —— notarytool 凭据只在闭包作用域内存在，
                                // 移出去会因「缺公证凭据」直接失败（APPLE_TEAM_ID 由 withEnv 提供，
                                // APPLE_ID / 专用密码由本闭包提供，缺一不可）。
                                sh 'npm run staple'
                            }
                        } else {
                            sh "${skipTests}npm run package"
                        }
                    }
                }
            }
            post {
                always {
                    archiveArtifacts(
                        artifacts: 'dist/package/*',
                        allowEmptyArchive: true,
                        fingerprint: true
                    )
                }
            }
        }
    }
}
