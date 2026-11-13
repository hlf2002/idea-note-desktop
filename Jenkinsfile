/*
 * 灵感笔记桌面端 —— Jenkins 多平台安装包构建流水线
 *
 * Jenkins 侧配置（New Item -> Pipeline）：
 *   Definition : Pipeline script from SCM
 *   SCM        : Git -> https://github.com/hlf2002/idea-note-desktop.git（main 分支）
 *   Script Path: Jenkinsfile
 *
 * 构建节点要求（Manage Jenkins -> Nodes，按标签挂到对应机器）：
 *   - 标签 windows：Windows 10/11 或 Server，Node.js >= 20、Git
 *   - 标签 macos  ：macOS，Node.js >= 20、Git
 *
 * 行为说明：
 *   - 默认产出未签名安装包（跳过 codesign / notarize），与 identity:null 时代行为一致。
 *   - 如需 Apple 公证：给 mac 节点装 Developer ID 证书，在 Jenkins 建用户名密码凭据
 *     apple-id（用户名=Apple ID，密码=App 专用密码），构建时勾选 NOTARIZE 参数。
 *     如账号归属多个团队，追加凭据 apple-team-id 并在 withCredentials 中映射
 *     APPLE_TEAM_ID 环境变量。
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
        booleanParam(name: 'NOTARIZE', defaultValue: false, description: 'mac 构建是否做 Apple 公证（需证书与凭据就绪）')
    }

    environment {
        CI = 'true'
        ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
        // 未配置签名证书时跳过自动发现，避免 macOS 无证书构建直接失败
        CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    }

    stages {
        stage('Windows 安装包（NSIS + zip）') {
            when { expression { params.TARGET == 'all' || params.TARGET == 'win' } }
            agent { label 'windows' }
            steps {
                bat 'node -v && npm -v'
                bat 'npm ci --no-audit --no-fund'
                script {
                    if (params.RUN_TESTS) {
                        bat 'npm test'
                    }
                }
                bat 'npm run build:win'
            }
            post {
                always {
                    archiveArtifacts(
                        artifacts: 'dist/*.exe,dist/*.zip,dist/*.blockmap,dist/latest.yml',
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
                    if (params.RUN_TESTS) {
                        sh 'npm test'
                    }
                    if (params.NOTARIZE) {
                        withCredentials([usernamePassword(
                            credentialsId: 'apple-id',
                            usernameVariable: 'APPLE_ID',
                            passwordVariable: 'APPLE_APP_SPECIFIC_PASSWORD'
                        )]) {
                            sh 'npm run build:mac'
                        }
                    } else {
                        sh 'npm run build:mac -- --config.mac.notarize=false'
                    }
                }
            }
            post {
                always {
                    archiveArtifacts(
                        artifacts: 'dist/*.dmg,dist/*.zip,dist/*.blockmap,dist/latest-mac.yml',
                        allowEmptyArchive: true,
                        fingerprint: true
                    )
                }
            }
        }
    }
}
