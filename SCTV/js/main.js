/* global webapis, tizen */

var APP_VERSION = "0.6.2";

/*
 * O parser abaixo tambem entende respostas simples de Worker:
 *   { "url": "https://...m3u8" }
 * ou
 *   { "streaming_url": "https://...m3u8" }
 *
 * Portanto, no futuro, para trocar o Firestore REST por um Worker,
 * basta alterar CONFIG_ENDPOINT; o restante do app nao precisa mudar.
 */
var FIREBASE_PROJECT_ID = "sctv-hd";
var FIREBASE_API_KEY = "AIzaSyDyMDLNk8Uow3tBS7sQt1mbZXp0KW9V1rE";
var FIRESTORE_DOCUMENT_PATH = "configs/streaming";
var FIRESTORE_FIELD_NAME = "streaming_url";

var CONFIG_ENDPOINT =
    "https://firestore.googleapis.com/v1/projects/" +
    FIREBASE_PROJECT_ID +
    "/databases/(default)/documents/" +
    FIRESTORE_DOCUMENT_PATH +
    "?key=" +
    encodeURIComponent(FIREBASE_API_KEY);

var REQUEST_TIMEOUT_MS = 15000;
var PREPARE_TIMEOUT_MS = 20000;
var RETRY_CURTO_MS = 4000;
var RETRY_LONGO_MS = 30000;
var MAX_TENTATIVAS_CONFIG_CURTAS = 4;
var MAX_TENTATIVAS_VIDEO_CURTAS = 5;

/*
 * Se o buffering iniciar e nunca completar, o AVPlay fica parado sem
 * emitir erro. Caso conhecido em firmwares Samsung: onbufferingprogress
 * repete o mesmo valor indefinidamente. Este limite reinicia o player.
 */
var STALL_TIMEOUT_MS = 25000;

/*
 * Depois deste numero de falhas de preparo com a playlist mestre, o app
 * tenta abrir a playlist de midia (chunklist) diretamente. Ver comentario
 * em tratarFalhaDePreparo().
 */
var MAX_PREPARE_ANTES_DE_FALLBACK = 2;

var KEY_LEFT = 37;
var KEY_UP = 38;
var KEY_RIGHT = 39;
var KEY_DOWN = 40;
var KEY_ENTER = 13;
var KEY_BACK = 10009;
var KEY_MEDIA_PLAY_PAUSE = 10252;
var KEY_MEDIA_PLAY = 415;
var KEY_MEDIA_PAUSE = 19;

var exitPromptOpen = false;
var focoSaida = "sim";

var appVisivel = true;
var redeConectada = true;
var playerPreparando = false;
var playerReproduzindo = false;
var playerSessionId = 0;

var urlAtual = null;
var tentativasConfig = 0;
var tentativasVideo = 0;

/*
 * urlMasterOriginal guarda a URL vinda da configuracao (playlist mestre).
 * Quando o preparo falha repetidamente, o app passa a usar a playlist de
 * midia extraida dela, e usandoPlaylistDeMidia registra esse estado.
 */
var urlMasterOriginal = null;
var usandoPlaylistDeMidia = false;
var tentativasPrepare = 0;

var timerStall = null;

var xhrConfigAtual = null;
var timerConfig = null;
var timerVideo = null;
var timerRetomar = null;
var networkListenerId = null;

/* Inicializacao                                                       */

function init() {
    console.log("SCTV-HD " + APP_VERSION + " iniciando.");
    logarInfoDaPlataforma();

    /* O controle deve funcionar mesmo se a rede ou o player falharem. */
    configurarControleRemoto();
    configurarBotoesDoPopup();

    configurarMonitoramentoDeRede();
    configurarMultitarefa();

    definirScreensaver(true);

    if (verificarRedeAtual()) {
        iniciarFluxo();
    } else {
        mostrarMensagem("Sem conexão com a internet. Verifique a rede da TV.");
    }
}

/*
 * Registra modelo e versao de firmware no console.
 *
 * Util ao abrir um chamado 1:1 na Samsung: o time de review nao informa
 * em qual aparelho reproduziu a falha, e estes dados permitem comparar
 * com o modelo testado localmente.
 */
function logarInfoDaPlataforma() {
    try {
        if (typeof tizen !== "undefined" && tizen.systeminfo) {
            console.log("Tizen: " + tizen.systeminfo.getCapability("http://tizen.org/feature/platform.version"));
        }
    } catch (e) {
        console.warn("Versão da plataforma indisponível: " + mensagemErro(e));
    }

    try {
        if (webapisDisponivel() && webapis.productinfo) {
            console.log("Modelo: " + webapis.productinfo.getRealModel());
            console.log("Firmware: " + webapis.productinfo.getFirmware());
        }
    } catch (e) {
        console.warn("Informações do produto indisponíveis: " + mensagemErro(e));
    }
}

/* Fluxo principal                                                     */

function iniciarFluxo() {
    if (!appVisivel || exitPromptOpen) {
        return;
    }

    cancelarTimerConfig();
    cancelarTimerVideo();
    abortarRequisicaoConfig();

    tentativasConfig = 0;
    buscarConfiguracao();
}

function buscarConfiguracao() {
    if (!appVisivel || exitPromptOpen) {
        return;
    }

    if (!verificarRedeAtual()) {
        mostrarMensagem("Sem conexão com a internet. Verifique a rede da TV.");
        return;
    }

    tentativasConfig++;
    mostrarMensagem("Conectando à transmissão...");

    carregarUrlDaConfiguracao(function (streamingUrl, erro) {
        if (!appVisivel || exitPromptOpen) {
            return;
        }

        if (streamingUrl) {
            tentativasConfig = 0;

            if (urlMasterOriginal !== streamingUrl) {
                console.log("Nova URL de streaming recebida.");

                /* URL diferente: recomeca do zero, sem herdar o fallback. */
                urlMasterOriginal = streamingUrl;
                usandoPlaylistDeMidia = false;
                tentativasPrepare = 0;
            }

            if (usandoPlaylistDeMidia && urlAtual) {
                /*
                 * Ja estamos usando a playlist de midia para esta mesma
                 * transmissao; manter, em vez de voltar para a mestre
                 * que acabou de falhar.
                 */
                iniciarVideo(urlAtual);
                return;
            }

            urlAtual = streamingUrl;
            iniciarVideo(streamingUrl);
            return;
        }

        console.warn("Falha ao obter URL do streaming: " + (erro || "erro desconhecido"));
        agendarNovaBuscaDeConfiguracao();
    });
}

function agendarNovaBuscaDeConfiguracao() {
    var atraso;

    cancelarTimerConfig();

    if (tentativasConfig < MAX_TENTATIVAS_CONFIG_CURTAS) {
        atraso = RETRY_CURTO_MS;
        mostrarMensagem("Conectando à transmissão...");
    } else {
        /* Depois das tentativas rapidas, continua tentando sem travar o app. */
        atraso = RETRY_LONGO_MS;
        tentativasConfig = 0;
        mostrarMensagem("Não foi possível carregar a transmissão. Tentaremos novamente automaticamente.");
    }

    timerConfig = setTimeout(function () {
        timerConfig = null;
        buscarConfiguracao();
    }, atraso);
}

/* Configuracao remota (Firestore REST ou Worker JSON)                 */

function carregarUrlDaConfiguracao(callback) {
    var xhr = new XMLHttpRequest();
    var finalizado = false;

    abortarRequisicaoConfig();
    xhrConfigAtual = xhr;

    function finalizar(url, erro) {
        if (finalizado) {
            return;
        }

        finalizado = true;

        if (xhrConfigAtual === xhr) {
            xhrConfigAtual = null;
        }

        callback(url, erro);
    }

    try {
        xhr.open("GET", CONFIG_ENDPOINT, true);
        xhr.timeout = REQUEST_TIMEOUT_MS;

        xhr.onreadystatechange = function () {
            var response;
            var streamingUrl;

            if (xhr.readyState !== 4) {
                return;
            }

            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    response = JSON.parse(xhr.responseText);
                    streamingUrl = extrairUrlDaResposta(response);

                    if (urlDeStreamingValida(streamingUrl)) {
                        finalizar(streamingUrl, null);
                    } else {
                        finalizar(null, "URL ausente ou inválida na configuração");
                    }
                } catch (e) {
                    finalizar(null, "JSON inválido: " + mensagemErro(e));
                }
            } else {
                finalizar(null, "HTTP " + xhr.status);
            }
        };

        xhr.ontimeout = function () {
            finalizar(null, "timeout ao consultar configuração");
        };

        xhr.onerror = function () {
            /*
             * onerror so dispara quando nao houve resposta HTTP nenhuma.
             * O teste abaixo separa "endpoint bloqueado" de "aparelho sem rede".
             * Pode ser removido depois que a causa for identificada.
             */
            diagnosticarRede();
            finalizar(null, "erro de rede ao consultar configuração");
        };

        xhr.onabort = function () {
            /* Abort e usado durante pausa, saida ou reinicio do fluxo. */
            finalizado = true;
        };

        xhr.send();
    } catch (e) {
        finalizar(null, "falha ao iniciar requisição: " + mensagemErro(e));
    }
}

function diagnosticarRede() {
    var teste = new XMLHttpRequest();

    try {
        teste.open("GET", "https://www.gstatic.com/generate_204", true);
        teste.timeout = 8000;

        teste.onload = function () {
            console.error(
                "DIAG: rede OK (HTTP " + teste.status + "). " +
                "A falha e especifica do endpoint de configuracao."
            );
        };

        teste.onerror = function () {
            console.error("DIAG: sem saida para a internet neste aparelho.");
        };

        teste.ontimeout = function () {
            console.error("DIAG: timeout no teste de rede.");
        };

        teste.send();
    } catch (e) {
        console.error("DIAG: falha ao executar teste de rede: " + mensagemErro(e));
    }
}

function extrairUrlDaResposta(response) {
    var field;

    if (!response) {
        return null;
    }

    /* Formato simples recomendado para um futuro Cloudflare Worker. */
    if (typeof response.url === "string") {
        return response.url;
    }

    if (typeof response.streaming_url === "string") {
        return response.streaming_url;
    }

    /* Formato REST nativo do Firestore usado pela 0.5.9. */
    if (response.fields && response.fields[FIRESTORE_FIELD_NAME]) {
        field = response.fields[FIRESTORE_FIELD_NAME];

        if (typeof field.stringValue === "string") {
            return field.stringValue;
        }
    }

    return null;
}

/* Playlist mestre -> playlist de midia                                */

/*
 * Le a playlist mestre e devolve a URL absoluta da primeira variante.
 *
 * Motivo: a playlist mestre desta transmissao aponta para um chunklist
 * com nome gerado por sessao (chunklist_w<numero>.m3u8, padrao Wowza).
 * Se o AVPlay engasgar na etapa mestre -> chunklist, abrir a playlist de
 * midia diretamente elimina esse salto. E uma tentativa de contorno, nao
 * o caminho normal: so e usada apos falhas repetidas de preparo.
 */
function resolverPlaylistDeMidia(masterUrl, callback) {
    var xhr = new XMLHttpRequest();

    try {
        xhr.open("GET", masterUrl, true);
        xhr.timeout = REQUEST_TIMEOUT_MS;

        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) {
                return;
            }

            if (xhr.status < 200 || xhr.status >= 300) {
                console.warn("Não foi possível ler a playlist mestre: HTTP " + xhr.status);
                callback(null);
                return;
            }

            callback(extrairPrimeiraVariante(xhr.responseText, masterUrl));
        };

        xhr.ontimeout = function () {
            callback(null);
        };

        xhr.onerror = function () {
            callback(null);
        };

        xhr.send();
    } catch (e) {
        console.warn("Falha ao consultar a playlist mestre: " + mensagemErro(e));
        callback(null);
    }
}

function extrairPrimeiraVariante(texto, baseUrl) {
    var conteudo = String(texto || "");
    var linhas;
    var linha;
    var i;

    /*
     * Sem EXT-X-STREAM-INF isto ja e uma playlist de midia: as linhas
     * seriam segmentos .ts, e devolve-las como "variante" quebraria o
     * player em vez de ajudar.
     */
    if (conteudo.indexOf("#EXT-X-STREAM-INF") === -1) {
        console.warn("A URL já é uma playlist de mídia; nada a resolver.");
        return null;
    }

    linhas = conteudo.split(/\r?\n/);

    for (i = 0; i < linhas.length; i++) {
        linha = linhas[i].replace(/^\s+|\s+$/g, "");

        if (linha === "" || linha.charAt(0) === "#") {
            continue;
        }

        return resolverUrlRelativa(linha, baseUrl);
    }

    return null;
}

function resolverUrlRelativa(caminho, baseUrl) {
    var corte;

    if (caminho.indexOf("http://") === 0 || caminho.indexOf("https://") === 0) {
        return caminho;
    }

    corte = baseUrl.indexOf("?");

    if (corte !== -1) {
        baseUrl = baseUrl.substring(0, corte);
    }

    corte = baseUrl.lastIndexOf("/");

    if (corte === -1) {
        return caminho;
    }

    return baseUrl.substring(0, corte + 1) + caminho;
}

function urlDeStreamingValida(url) {
    if (typeof url !== "string" || url.length < 8) {
        return false;
    }

    /* O app distribuido deve usar transporte seguro. */
    return url.indexOf("https://") === 0;
}

function abortarRequisicaoConfig() {
    if (!xhrConfigAtual) {
        return;
    }

    try {
        xhrConfigAtual.abort();
    } catch (e) {
        console.warn("Falha ao abortar requisição: " + mensagemErro(e));
    }

    xhrConfigAtual = null;
}

/* AVPlay                                                              */

function iniciarVideo(streamingUrl) {
    var minhaSessao;
    var timeoutPreparo = null;

    if (!appVisivel || exitPromptOpen) {
        return;
    }

    if (!webapisDisponivel() || !webapis.avplay) {
        console.error("AVPlay não está disponível neste dispositivo.");
        mostrarMensagem("Não foi possível iniciar o player desta TV.");
        agendarReconexaoVideo("AVPlay indisponível");
        return;
    }

    cancelarTimerVideo();
    fecharPlayer();

    playerSessionId++;
    minhaSessao = playerSessionId;
    playerPreparando = true;
    playerReproduzindo = false;

    mostrarMensagem("Carregando transmissão...");

    try {
        console.log("AVPlay.open()");
        webapis.avplay.open(streamingUrl);

        webapis.avplay.setListener(criarListenerAVPlay(minhaSessao));

        /* AVPlay sempre usa coordenadas baseadas em 1920x1080. */
        webapis.avplay.setDisplayRect(0, 0, 1920, 1080);

        try {
            webapis.avplay.setDisplayMethod("PLAYER_DISPLAY_MODE_LETTER_BOX");
        } catch (displayError) {
            /* Alguns firmwares antigos podem nao expor este metodo. */
            console.warn("setDisplayMethod não aplicado: " + mensagemErro(displayError));
        }

        try {
            webapis.avplay.setTimeoutForBuffering(15);
        } catch (bufferError) {
            console.warn("Timeout de buffering não configurado: " + mensagemErro(bufferError));
        }

        /*
         * Watchdog do prepareAsync.
         *
         * Firmwares Samsung tem casos conhecidos em que prepareAsync() nunca
         * chama nenhum dos dois callbacks para certos streams HLS: nem
         * sucesso, nem erro, sem log algum. Sem isto, o app fica preso na
         * tela "Carregando transmissão..." para sempre. setTimeoutForBuffering
         * nao ajuda aqui: ele cobre engasgos durante a reproducao, nao esta
         * fase inicial de preparo.
         */
        timeoutPreparo = setTimeout(function () {
            timeoutPreparo = null;

            if (minhaSessao !== playerSessionId || !appVisivel) {
                return;
            }

            console.error(
                "AVPlay.prepareAsync não respondeu em " +
                (PREPARE_TIMEOUT_MS / 1000) + "s (nenhum callback disparou)."
            );
            playerPreparando = false;
            tratarFalhaDePreparo("timeout ao preparar transmissão");
        }, PREPARE_TIMEOUT_MS);

        webapis.avplay.prepareAsync(
            function () {
                if (timeoutPreparo !== null) {
                    clearTimeout(timeoutPreparo);
                    timeoutPreparo = null;
                }

                if (minhaSessao !== playerSessionId || !appVisivel) {
                    return;
                }

                playerPreparando = false;

                try {
                    console.log("AVPlay preparado. Iniciando reprodução.");
                    webapis.avplay.play();
                    playerReproduzindo = true;
                    tentativasVideo = 0;
                    tentativasPrepare = 0;
                    esconderCarregamento();
                    definirScreensaver(false);
                } catch (playError) {
                    console.error("Falha em AVPlay.play(): " + mensagemErro(playError));
                    agendarReconexaoVideo("falha ao iniciar reprodução");
                }
            },
            function (error) {
                if (timeoutPreparo !== null) {
                    clearTimeout(timeoutPreparo);
                    timeoutPreparo = null;
                }

                if (minhaSessao !== playerSessionId) {
                    return;
                }

                playerPreparando = false;
                console.error("AVPlay.prepareAsync falhou: " + mensagemErro(error));
                tratarFalhaDePreparo("falha ao preparar transmissão");
            }
        );
    } catch (e) {
        if (timeoutPreparo !== null) {
            clearTimeout(timeoutPreparo);
            timeoutPreparo = null;
        }
        playerPreparando = false;
        playerReproduzindo = false;
        console.error("Falha ao abrir AVPlay: " + mensagemErro(e));
        agendarReconexaoVideo("falha ao abrir transmissão");
    }
}

function criarListenerAVPlay(sessao) {
    return {
        onbufferingstart: function () {
            if (sessao !== playerSessionId) {
                return;
            }

            console.log("AVPlay buffering iniciado.");
            mostrarMensagem("Carregando transmissão...");
            armarTimerDeTravamento();
        },

        onbufferingprogress: function (percent) {
            if (sessao !== playerSessionId) {
                return;
            }

            console.log("AVPlay buffering: " + percent + "%");

            /*
             * Cada avanco real renova o prazo. Se o valor parar de mudar,
             * o timer nao e renovado e o player e reiniciado.
             */
            armarTimerDeTravamento();
        },

        onbufferingcomplete: function () {
            if (sessao !== playerSessionId) {
                return;
            }

            console.log("AVPlay buffering concluído.");
            cancelarTimerDeTravamento();
        },

        onstreamcompleted: function () {
            if (sessao !== playerSessionId) {
                return;
            }

            console.warn("AVPlay informou fim do stream.");
            agendarReconexaoVideo("stream encerrado");
        },

        oncurrentplaytime: function () {
            if (sessao !== playerSessionId) {
                return;
            }

            /* Tempo de reproducao avancando: nao ha travamento. */
            cancelarTimerDeTravamento();

            if (!playerReproduzindo) {
                playerReproduzindo = true;
                tentativasVideo = 0;
                tentativasPrepare = 0;
                esconderCarregamento();
                definirScreensaver(false);
            }
        },

        onerror: function (eventType) {
            if (sessao !== playerSessionId) {
                return;
            }

            console.error("Erro AVPlay: " + eventType);
            agendarReconexaoVideo("erro do player: " + eventType);
        },

        onevent: function (eventType, eventData) {
            if (sessao !== playerSessionId) {
                return;
            }

            console.log("Evento AVPlay: " + eventType + " / " + eventData);
        },

        onsubtitlechange: function () {
            /* Sem legendas neste app. */
        },

        ondrmevent: function (drmEvent, drmData) {
            console.log("Evento DRM: " + drmEvent + " / " + drmData);
        }
    };
}

/*
 * Decide o que fazer quando o preparo falha.
 *
 * Nas primeiras falhas, reconecta normalmente. Se a playlist mestre falhar
 * de forma persistente, tenta uma vez abrir a playlist de midia diretamente
 * antes de voltar ao ciclo normal de reconexao.
 */
function tratarFalhaDePreparo(motivo) {
    tentativasPrepare++;

    if (usandoPlaylistDeMidia ||
        tentativasPrepare < MAX_PREPARE_ANTES_DE_FALLBACK ||
        !urlMasterOriginal) {
        agendarReconexaoVideo(motivo);
        return;
    }

    console.warn("Preparo falhou repetidamente. Tentando a playlist de mídia diretamente.");

    resolverPlaylistDeMidia(urlMasterOriginal, function (mediaUrl) {
        if (!appVisivel || exitPromptOpen) {
            return;
        }

        if (mediaUrl && urlDeStreamingValida(mediaUrl)) {
            console.log("Playlist de mídia resolvida. Reabrindo o player com ela.");
            usandoPlaylistDeMidia = true;
            tentativasPrepare = 0;
            urlAtual = mediaUrl;
            iniciarVideo(mediaUrl);
            return;
        }

        console.warn("Não foi possível resolver a playlist de mídia.");
        agendarReconexaoVideo(motivo);
    });
}

function agendarReconexaoVideo(motivo) {
    var atraso;

    if (!appVisivel || exitPromptOpen) {
        return;
    }

    if (timerVideo !== null) {
        return;
    }

    playerPreparando = false;
    playerReproduzindo = false;
    tentativasVideo++;

    console.warn("Reconexão solicitada: " + motivo + ". Tentativa " + tentativasVideo + ".");

    fecharPlayer();
    definirScreensaver(true);

    if (tentativasVideo <= MAX_TENTATIVAS_VIDEO_CURTAS) {
        atraso = RETRY_CURTO_MS;
        mostrarMensagem("Reconectando à transmissão...");
    } else {
        atraso = RETRY_LONGO_MS;
        tentativasVideo = 0;
        mostrarMensagem("A transmissão está indisponível. Tentaremos novamente automaticamente.");
    }

    timerVideo = setTimeout(function () {
        timerVideo = null;

        /* Reconsulta a configuracao: a URL pode ter mudado durante a falha. */
        tentativasConfig = 0;
        buscarConfiguracao();
    }, atraso);
}

function fecharPlayer() {
    var estado = null;

    playerSessionId++;
    playerPreparando = false;
    playerReproduzindo = false;
    cancelarTimerDeTravamento();

    if (!webapisDisponivel() || !webapis.avplay) {
        return;
    }

    try {
        estado = webapis.avplay.getState();
    } catch (stateError) {
        estado = null;
    }

    try {
        if (estado === "PLAYING" || estado === "PAUSED" || estado === "READY") {
            webapis.avplay.stop();
        }
    } catch (stopError) {
        console.warn("AVPlay.stop ignorado: " + mensagemErro(stopError));
    }

    try {
        /* close() remove a instancia e volta ao estado NONE. */
        webapis.avplay.close();
    } catch (closeError) {
        /* Se ja estiver NONE, alguns firmwares lançam InvalidStateError. */
        console.warn("AVPlay.close ignorado: " + mensagemErro(closeError));
    }
}

function pausarVideo() {
    if (!webapisDisponivel() || !webapis.avplay) {
        return;
    }

    try {
        if (webapis.avplay.getState() === "PLAYING") {
            webapis.avplay.pause();
            playerReproduzindo = false;
            definirScreensaver(true);
            console.log("Reprodução pausada pelo controle remoto.");
        }
    } catch (e) {
        console.warn("Não foi possível pausar: " + mensagemErro(e));
    }
}

function retomarVideo() {
    if (!webapisDisponivel() || !webapis.avplay) {
        return;
    }

    try {
        if (webapis.avplay.getState() === "PAUSED") {
            webapis.avplay.play();
            playerReproduzindo = true;
            esconderCarregamento();
            definirScreensaver(false);
            console.log("Reprodução retomada pelo controle remoto.");
        }
    } catch (e) {
        console.warn("Não foi possível retomar: " + mensagemErro(e));
    }
}

function alternarPlayPause() {
    var estado;

    if (!webapisDisponivel() || !webapis.avplay) {
        return;
    }

    try {
        estado = webapis.avplay.getState();

        if (estado === "PLAYING") {
            pausarVideo();
        } else if (estado === "PAUSED") {
            retomarVideo();
        }
    } catch (e) {
        console.warn("Não foi possível alternar Play/Pause: " + mensagemErro(e));
    }
}

/* Rede                                                                */

function configurarMonitoramentoDeRede() {
    if (!webapisDisponivel() || !webapis.network) {
        console.warn("Network API indisponível; o app seguirá usando erros das requisições/player.");
        return;
    }

    try {
        networkListenerId = webapis.network.addNetworkStateChangeListener(function (value) {
            console.log("Network state: " + value);

            if (value === webapis.network.NetworkState.GATEWAY_DISCONNECTED) {
                redeConectada = false;
                tratarRedeDesconectada();
            } else if (value === webapis.network.NetworkState.GATEWAY_CONNECTED) {
                redeConectada = true;
                tratarRedeReconectada();
            }
        });
    } catch (e) {
        console.warn("Monitoramento de rede não configurado: " + mensagemErro(e));
    }
}

function verificarRedeAtual() {
    if (!webapisDisponivel() || !webapis.network) {
        return redeConectada;
    }

    try {
        redeConectada = webapis.network.isConnectedToGateway();
        return redeConectada;
    } catch (e) {
        console.warn("Não foi possível consultar o gateway: " + mensagemErro(e));
        return redeConectada;
    }
}

function tratarRedeDesconectada() {
    cancelarTimers();
    abortarRequisicaoConfig();
    fecharPlayer();
    definirScreensaver(true);
    mostrarMensagem("Sem conexão com a internet. Verifique a rede da TV.");
}

function tratarRedeReconectada() {
    if (!appVisivel || exitPromptOpen) {
        return;
    }

    mostrarMensagem("Conexão restabelecida. Reconectando...");
    agendarRetomada(1500);
}

/* Multitarefa                                                         */

function configurarMultitarefa() {
    document.addEventListener("visibilitychange", function () {
        if (document.hidden) {
            console.log("Aplicativo em segundo plano.");
            appVisivel = false;

            cancelarTimers();
            abortarRequisicaoConfig();
            fecharPlayer();
            definirScreensaver(true);
        } else {
            console.log("Aplicativo retornou ao primeiro plano.");
            appVisivel = true;

            /* A Samsung recomenda verificar a rede antes de retomar streaming. */
            if (verificarRedeAtual()) {
                mostrarMensagem("Reconectando à transmissão...");
                agendarRetomada(1000);
            } else {
                mostrarMensagem("Sem conexão com a internet. Verifique a rede da TV.");
            }
        }
    });
}

function agendarRetomada(atraso) {
    if (timerRetomar !== null) {
        clearTimeout(timerRetomar);
    }

    timerRetomar = setTimeout(function () {
        timerRetomar = null;
        iniciarFluxo();
    }, atraso);
}

/* Screensaver                                                         */

function definirScreensaver(ligado) {
    var estado;

    if (!webapisDisponivel() || !webapis.appcommon) {
        return;
    }

    try {
        estado = ligado
            ? webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON
            : webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF;

        webapis.appcommon.setScreenSaver(
            estado,
            function () {},
            function (error) {
                console.warn("Erro ao alterar screensaver: " + mensagemErro(error));
            }
        );
    } catch (e) {
        console.warn("Screensaver não ajustado: " + mensagemErro(e));
    }
}

/* Controle remoto                                                     */

function configurarControleRemoto() {
    registrarTeclasDeMidia();

    document.addEventListener("keydown", function (e) {
        var keyCode = e.keyCode;
        var tratado = false;

        if (exitPromptOpen) {
            tratado = tratarTeclaNoPopup(keyCode);
        } else {
            switch (keyCode) {
                case KEY_BACK:
                    abrirPopupDeSaida();
                    tratado = true;
                    break;

                case KEY_MEDIA_PLAY_PAUSE:
                    alternarPlayPause();
                    tratado = true;
                    break;

                case KEY_MEDIA_PLAY:
                    retomarVideo();
                    tratado = true;
                    break;

                case KEY_MEDIA_PAUSE:
                    pausarVideo();
                    tratado = true;
                    break;

                default:
                    console.log("Key code: " + keyCode);
                    break;
            }
        }

        if (tratado) {
            if (e.preventDefault) {
                e.preventDefault();
            }

            if (e.stopPropagation) {
                e.stopPropagation();
            }
        }
    });
}

function registrarTeclasDeMidia() {
    var teclas = ["MediaPlayPause", "MediaPlay", "MediaPause"];
    var i;

    /*
     * Back, Enter e setas NAO sao registrados: a Samsung os entrega
     * automaticamente. Registramos somente teclas especiais de midia.
     */
    try {
        if (typeof tizen === "undefined" || !tizen.tvinputdevice) {
            return;
        }

        for (i = 0; i < teclas.length; i++) {
            try {
                tizen.tvinputdevice.registerKey(teclas[i]);
                console.log("Tecla registrada: " + teclas[i]);
            } catch (keyError) {
                console.warn("Tecla não registrada (" + teclas[i] + "): " + mensagemErro(keyError));
            }
        }
    } catch (e) {
        console.warn("TVInputDevice indisponível: " + mensagemErro(e));
    }
}

function tratarTeclaNoPopup(keyCode) {
    switch (keyCode) {
        case KEY_LEFT:
        case KEY_RIGHT:
        case KEY_UP:
        case KEY_DOWN:
            focoSaida = focoSaida === "sim" ? "nao" : "sim";
            atualizarFocoSaida();
            return true;

        case KEY_ENTER:
            if (focoSaida === "sim") {
                sairDoAplicativo();
            } else {
                fecharPopupDeSaida();
            }
            return true;

        case KEY_BACK:
            fecharPopupDeSaida();
            return true;

        default:
            return false;
    }
}

function configurarBotoesDoPopup() {
    var btnSim = document.getElementById("btnSim");
    var btnNao = document.getElementById("btnNao");

    if (btnSim) {
        btnSim.onclick = function () {
            focoSaida = "sim";
            atualizarFocoSaida();
            sairDoAplicativo();
        };
    }

    if (btnNao) {
        btnNao.onclick = function () {
            focoSaida = "nao";
            atualizarFocoSaida();
            fecharPopupDeSaida();
        };
    }
}

function abrirPopupDeSaida() {
    var popup = document.getElementById("exitPrompt");

    if (exitPromptOpen || !popup) {
        return;
    }

    exitPromptOpen = true;
    focoSaida = "sim";
    atualizarFocoSaida();
    removerClasse(popup, "hidden");
}

function fecharPopupDeSaida() {
    var popup = document.getElementById("exitPrompt");

    if (popup) {
        adicionarClasse(popup, "hidden");
    }

    exitPromptOpen = false;
}

function atualizarFocoSaida() {
    var btnSim = document.getElementById("btnSim");
    var btnNao = document.getElementById("btnNao");

    if (!btnSim || !btnNao) {
        return;
    }

    btnSim.className = focoSaida === "sim" ? "exitBtn focado" : "exitBtn";
    btnNao.className = focoSaida === "nao" ? "exitBtn focado" : "exitBtn";
}

function sairDoAplicativo() {
    console.log("Saindo do SCTV-HD.");

    cancelarTimers();
    abortarRequisicaoConfig();
    fecharPlayer();
    definirScreensaver(true);

    try {
        if (typeof tizen !== "undefined" && tizen.application) {
            tizen.application.getCurrentApplication().exit();
        }
    } catch (e) {
        console.error("Erro ao sair do aplicativo: " + mensagemErro(e));
        exitPromptOpen = false;
    }
}

/* Interface                                                           */

function mostrarMensagem(texto) {
    var loadingLayer = document.getElementById("loadingLayer");
    var mensagem = document.getElementById("mensagem");

    if (loadingLayer) {
        removerClasse(loadingLayer, "hidden");
    }

    if (mensagem) {
        mensagem.innerHTML = escaparHtml(texto);
    }
}

function esconderCarregamento() {
    var loadingLayer = document.getElementById("loadingLayer");

    if (loadingLayer) {
        adicionarClasse(loadingLayer, "hidden");
    }
}

/* Utilitarios                                                         */

function webapisDisponivel() {
    return typeof webapis !== "undefined";
}

function cancelarTimerConfig() {
    if (timerConfig !== null) {
        clearTimeout(timerConfig);
        timerConfig = null;
    }
}

function cancelarTimerVideo() {
    if (timerVideo !== null) {
        clearTimeout(timerVideo);
        timerVideo = null;
    }
}

function armarTimerDeTravamento() {
    cancelarTimerDeTravamento();

    timerStall = setTimeout(function () {
        timerStall = null;

        if (!appVisivel || exitPromptOpen) {
            return;
        }

        console.error(
            "Buffering parado por mais de " + (STALL_TIMEOUT_MS / 1000) +
            "s sem avançar. Reiniciando o player."
        );
        agendarReconexaoVideo("buffering travado");
    }, STALL_TIMEOUT_MS);
}

function cancelarTimerDeTravamento() {
    if (timerStall !== null) {
        clearTimeout(timerStall);
        timerStall = null;
    }
}

function cancelarTimers() {
    cancelarTimerConfig();
    cancelarTimerVideo();
    cancelarTimerDeTravamento();

    if (timerRetomar !== null) {
        clearTimeout(timerRetomar);
        timerRetomar = null;
    }
}

function mensagemErro(error) {
    if (!error) {
        return "erro desconhecido";
    }

    if (error.name || error.message) {
        return (error.name ? error.name + ": " : "") + (error.message || "");
    }

    return String(error);
}

function escaparHtml(texto) {
    return String(texto)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function adicionarClasse(elemento, classe) {
    if (!elemento) {
        return;
    }

    if ((" " + elemento.className + " ").indexOf(" " + classe + " ") === -1) {
        elemento.className = (elemento.className + " " + classe).replace(/^\s+|\s+$/g, "");
    }
}

function removerClasse(elemento, classe) {
    var regex;

    if (!elemento) {
        return;
    }

    regex = new RegExp("(^|\\s)" + classe + "(?=\\s|$)", "g");
    elemento.className = elemento.className.replace(regex, " ").replace(/^\s+|\s+$/g, "");
}

window.onload = init;