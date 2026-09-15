/* global webapis, tizen */

var APP_VERSION = "0.6.3";

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

/*
 * Teto para a variante escolhida no fallback. O fallback desliga o ABR, entao
 * a rendition escolhida e definitiva: sem teto, um encoder publicando 4K
 * travaria os modelos de entrada da frota (o app cobre Tizen 6.0 a 9.0) e
 * qualquer rede apertada, sem o player poder descer sozinho.
 */
var MAX_BANDWIDTH_FALLBACK = 3000000;
var MAX_ALTURA_FALLBACK = 1080;

var KEY_LEFT = 37;
var KEY_UP = 38;
var KEY_RIGHT = 39;
var KEY_DOWN = 40;
var KEY_ENTER = 13;
var KEY_BACK = 10009;
var KEY_MEDIA_PLAY_PAUSE = 10252;
var KEY_MEDIA_PLAY = 415;
var KEY_MEDIA_PAUSE = 19;

/*
 * Diagnostico na tela.
 *
 * O relatorio de reprovacao da Samsung nao diz em qual aparelho a falha foi
 * reproduzida, e o inspetor remoto nao existe numa TV de loja ou de terceiro.
 * Cinco toques em CIMA dentro da janela abaixo abrem um painel com modelo,
 * firmware, URL em uso e as ultimas linhas de log. CIMA nao tem outra funcao
 * fora do popup de saida, entao nao conflita com o uso normal do controle.
 */
var DIAG_TOQUES = 5;
var DIAG_JANELA_MS = 3000;
var LOG_MAX = 80;

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

/*
 * Ultimo percentual informado por onbufferingprogress. O watchdog de
 * travamento so pode ser renovado quando este valor muda de fato; ver
 * comentario em onbufferingprogress.
 */
var ultimoPercentBuffering = null;

var diagAberto = false;
var toquesDiag = 0;
var ultimoToqueDiag = 0;
var logRing = [];
var infoPlataforma = {
    tizen: "desconhecido",
    modelo: "desconhecido",
    firmware: "desconhecido"
};

var xhrConfigAtual = null;
var timerConfig = null;
var timerVideo = null;
var timerRetomar = null;
var networkListenerId = null;

/* Inicializacao                                                       */

function init() {
    logInfo("SCTV-HD " + APP_VERSION + " iniciando.");
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
 * Registra modelo e versao de firmware no log e guarda em infoPlataforma,
 * para o painel de diagnostico mostrar.
 *
 * Util ao abrir um chamado 1:1 na Samsung: o time de review nao informa
 * em qual aparelho reproduziu a falha, e estes dados permitem comparar
 * com o modelo testado localmente.
 */
function logarInfoDaPlataforma() {
    try {
        if (typeof tizen !== "undefined" && tizen.systeminfo) {
            infoPlataforma.tizen = tizen.systeminfo.getCapability("http://tizen.org/feature/platform.version");
            logInfo("Tizen: " + infoPlataforma.tizen);
        }
    } catch (e) {
        logAviso("Versão da plataforma indisponível: " + mensagemErro(e));
    }

    try {
        if (webapisDisponivel() && webapis.productinfo) {
            infoPlataforma.modelo = webapis.productinfo.getRealModel();
            infoPlataforma.firmware = webapis.productinfo.getFirmware();
            logInfo("Modelo: " + infoPlataforma.modelo);
            logInfo("Firmware: " + infoPlataforma.firmware);
        }
    } catch (e) {
        logAviso("Informações do produto indisponíveis: " + mensagemErro(e));
    }
}

/* Fluxo principal                                                     */

function iniciarFluxo() {
    if (!appVisivel) {
        return;
    }

    cancelarTimerConfig();
    cancelarTimerVideo();
    abortarRequisicaoConfig();

    tentativasConfig = 0;
    buscarConfiguracao();
}

function buscarConfiguracao() {
    if (!appVisivel) {
        return;
    }

    if (!verificarRedeAtual()) {
        mostrarMensagem("Sem conexão com a internet. Verifique a rede da TV.");
        return;
    }

    tentativasConfig++;
    mostrarMensagem("Conectando à transmissão...");

    carregarUrlDaConfiguracao(function (streamingUrl, erro) {
        if (!appVisivel) {
            return;
        }

        if (streamingUrl) {
            tentativasConfig = 0;

            if (urlMasterOriginal !== streamingUrl) {
                logInfo("Nova URL de streaming recebida.");

                /* URL diferente: recomeca do zero, sem herdar o fallback. */
                urlMasterOriginal = streamingUrl;
                usandoPlaylistDeMidia = false;
                tentativasPrepare = 0;
            }

            if (usandoPlaylistDeMidia) {
                /*
                 * Seguimos com a playlist de midia para esta transmissao, em
                 * vez de voltar para a mestre que acabou de falhar. Mas a
                 * chunklist do Wowza tem nome por sessao
                 * (chunklist_w<numero>.m3u8) e expira: reusar a URL anterior
                 * deixaria o app em 404 permanente, entao ela e re-resolvida
                 * a partir da mestre a cada ciclo.
                 */
                reabrirComPlaylistDeMidia(streamingUrl);
                return;
            }

            urlAtual = streamingUrl;
            iniciarVideo(streamingUrl);
            return;
        }

        logAviso("Falha ao obter URL do streaming: " + (erro || "erro desconhecido"));
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
            logErro(
                "DIAG: rede OK (HTTP " + teste.status + "). " +
                "A falha e especifica do endpoint de configuracao."
            );
        };

        teste.onerror = function () {
            logErro("DIAG: sem saida para a internet neste aparelho.");
        };

        teste.ontimeout = function () {
            logErro("DIAG: timeout no teste de rede.");
        };

        teste.send();
    } catch (e) {
        logErro("DIAG: falha ao executar teste de rede: " + mensagemErro(e));
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
 * Re-resolve a chunklist a partir da playlist mestre e reabre o player com
 * ela. Se a resolucao falhar, volta para a mestre em vez de insistir numa URL
 * de sessao possivelmente morta.
 */
function reabrirComPlaylistDeMidia(masterUrl) {
    resolverPlaylistDeMidia(masterUrl, function (mediaUrl) {
        if (!appVisivel) {
            return;
        }

        if (mediaUrl && urlDeStreamingValida(mediaUrl)) {
            urlAtual = mediaUrl;
            iniciarVideo(mediaUrl);
            return;
        }

        logAviso("Playlist de mídia indisponível; voltando para a playlist mestre.");
        usandoPlaylistDeMidia = false;
        tentativasPrepare = 0;
        urlAtual = masterUrl;
        iniciarVideo(masterUrl);
    });
}

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
                logAviso("Não foi possível ler a playlist mestre: HTTP " + xhr.status);
                callback(null);
                return;
            }

            callback(extrairMelhorVariante(xhr.responseText, masterUrl));
        };

        xhr.ontimeout = function () {
            callback(null);
        };

        xhr.onerror = function () {
            callback(null);
        };

        xhr.send();
    } catch (e) {
        logAviso("Falha ao consultar a playlist mestre: " + mensagemErro(e));
        callback(null);
    }
}

function extrairMelhorVariante(texto, baseUrl) {
    var conteudo = String(texto || "");
    var linhas;
    var linha;
    var i;
    var achado;
    var banda = -1;
    var altura = 0;
    var melhorBanda = -1;
    var melhorUri = null;
    var menorBanda = -1;
    var menorUri = null;

    /*
     * Sem EXT-X-STREAM-INF isto ja e uma playlist de midia: as linhas
     * seriam segmentos .ts, e devolve-las como "variante" quebraria o
     * player em vez de ajudar.
     */
    if (conteudo.indexOf("#EXT-X-STREAM-INF") === -1) {
        logAviso("A URL já é uma playlist de mídia; nada a resolver.");
        return null;
    }

    linhas = conteudo.split(/\r?\n/);

    for (i = 0; i < linhas.length; i++) {
        linha = linhas[i].replace(/^\s+|\s+$/g, "");

        if (linha === "") {
            continue;
        }

        if (linha.indexOf("#EXT-X-STREAM-INF") === 0) {
            achado = /BANDWIDTH=(\d+)/.exec(linha);
            banda = achado ? parseInt(achado[1], 10) : 0;

            achado = /RESOLUTION=\d+x(\d+)/.exec(linha);
            altura = achado ? parseInt(achado[1], 10) : 0;
            continue;
        }

        if (linha.charAt(0) === "#") {
            continue;
        }

        /* Guardada como rede de seguranca caso nada caiba no teto. */
        if (menorBanda === -1 || banda < menorBanda) {
            menorBanda = banda;
            menorUri = linha;
        }

        /*
         * A primeira variante do Wowza e a de menor bitrate, e este fallback
         * desliga o ABR: pegar a primeira entregaria 426x240 numa TV 4K, e
         * pegar a maior poderia engasgar num modelo de entrada de 2021 ou numa
         * rede apertada, sem o player poder descer sozinho. Escolhemos a maior
         * que ainda caiba no teto.
         */
        if (banda <= MAX_BANDWIDTH_FALLBACK &&
            altura <= MAX_ALTURA_FALLBACK &&
            banda > melhorBanda) {
            melhorBanda = banda;
            melhorUri = linha;
        }

        banda = -1;
        altura = 0;
    }

    if (melhorUri === null) {
        if (menorUri === null) {
            return null;
        }

        /*
         * Todas as renditions passam do teto (encoder so publicando 4K, por
         * exemplo). A de menor banda e a aposta mais segura.
         */
        logAviso(
            "Nenhuma variante dentro do teto de " + MAX_BANDWIDTH_FALLBACK +
            " bps; usando a de menor banda (" + menorBanda + " bps)."
        );

        return resolverUrlRelativa(menorUri, baseUrl);
    }

    logInfo("Variante escolhida: " + melhorBanda + " bps.");

    return resolverUrlRelativa(melhorUri, baseUrl);
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
    if (url.indexOf("https://") !== 0) {
        logErro(
            "URL de streaming rejeitada: o app exige https:// e recebeu \"" +
            url.substring(0, 12) + "...\". Corrija a configuração remota."
        );
        return false;
    }

    return true;
}

function abortarRequisicaoConfig() {
    if (!xhrConfigAtual) {
        return;
    }

    try {
        xhrConfigAtual.abort();
    } catch (e) {
        logAviso("Falha ao abortar requisição: " + mensagemErro(e));
    }

    xhrConfigAtual = null;
}

/* AVPlay                                                              */

function iniciarVideo(streamingUrl) {
    var minhaSessao;
    var timeoutPreparo = null;

    if (!appVisivel) {
        return;
    }

    if (!webapisDisponivel() || !webapis.avplay) {
        logErro("AVPlay não está disponível neste dispositivo.");
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
        logInfo("AVPlay.open()");
        webapis.avplay.open(streamingUrl);

        webapis.avplay.setListener(criarListenerAVPlay(minhaSessao));

        /* AVPlay sempre usa coordenadas baseadas em 1920x1080. */
        webapis.avplay.setDisplayRect(0, 0, 1920, 1080);

        try {
            webapis.avplay.setDisplayMethod("PLAYER_DISPLAY_MODE_LETTER_BOX");
        } catch (displayError) {
            /* Alguns firmwares antigos podem nao expor este metodo. */
            logAviso("setDisplayMethod não aplicado: " + mensagemErro(displayError));
        }

        try {
            webapis.avplay.setTimeoutForBuffering(15);
        } catch (bufferError) {
            logAviso("Timeout de buffering não configurado: " + mensagemErro(bufferError));
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

            logErro(
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
                    logInfo("AVPlay preparado. Iniciando reprodução.");
                    webapis.avplay.play();
                    playerReproduzindo = true;
                    tentativasVideo = 0;
                    tentativasPrepare = 0;
                    esconderCarregamento();
                    definirScreensaver(false);
                } catch (playError) {
                    logErro("Falha em AVPlay.play(): " + mensagemErro(playError));
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
                logErro("AVPlay.prepareAsync falhou: " + mensagemErro(error));
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
        logErro("Falha ao abrir AVPlay: " + mensagemErro(e));
        agendarReconexaoVideo("falha ao abrir transmissão");
    }
}

function criarListenerAVPlay(sessao) {
    return {
        onbufferingstart: function () {
            if (sessao !== playerSessionId) {
                return;
            }

            logInfo("AVPlay buffering iniciado.");
            mostrarMensagem("Carregando transmissão...");
            ultimoPercentBuffering = null;
            armarTimerDeTravamento();
        },

        onbufferingprogress: function (percent) {
            if (sessao !== playerSessionId) {
                return;
            }

            logInfo("AVPlay buffering: " + percent + "%");

            /*
             * Somente um avanco real renova o prazo. Renovar a cada callback
             * anularia a protecao exatamente no caso que ela existe para
             * cobrir: firmwares Samsung que repetem o mesmo percentual
             * indefinidamente. Com a renovacao incondicional o timer nunca
             * vencia e o player nunca reiniciava.
             */
            if (percent !== ultimoPercentBuffering) {
                ultimoPercentBuffering = percent;
                armarTimerDeTravamento();
            }
        },

        onbufferingcomplete: function () {
            if (sessao !== playerSessionId) {
                return;
            }

            logInfo("AVPlay buffering concluído.");
            cancelarTimerDeTravamento();

            /*
             * onbufferingstart reexibe a camada de carregamento via
             * mostrarMensagem. Sem esconde-la aqui, qualquer engasgo no meio
             * da transmissao deixaria a tela de espera por cima do video para
             * sempre, com o audio tocando: o player segue em PLAYING e
             * oncurrentplaytime nao reesconde a camada por playerReproduzindo
             * ja ser true.
             */
            esconderCarregamento();
        },

        onstreamcompleted: function () {
            if (sessao !== playerSessionId) {
                return;
            }

            logAviso("AVPlay informou fim do stream.");
            agendarReconexaoVideo("stream encerrado");
        },

        oncurrentplaytime: function () {
            if (sessao !== playerSessionId) {
                return;
            }

            /* Tempo de reproducao avancando: nao ha travamento. */
            cancelarTimerDeTravamento();

            /*
             * O tempo avancou, logo existe imagem: a camada de espera sai
             * sempre, e nao apenas na primeira vez. Ver F1 em
             * onbufferingcomplete.
             */
            esconderCarregamento();

            if (!playerReproduzindo) {
                playerReproduzindo = true;
                tentativasVideo = 0;
                tentativasPrepare = 0;
                definirScreensaver(false);
            }
        },

        onerror: function (eventType) {
            if (sessao !== playerSessionId) {
                return;
            }

            logErro(
                "Erro AVPlay: " + eventType +
                " | estado=" + estadoDoPlayer() +
                " | playlist=" + (usandoPlaylistDeMidia ? "chunklist" : "mestre") +
                " | url=" + (urlAtual || "nenhuma")
            );
            agendarReconexaoVideo("erro do player: " + eventType);
        },

        onevent: function (eventType, eventData) {
            if (sessao !== playerSessionId) {
                return;
            }

            logInfo("Evento AVPlay: " + eventType + " / " + eventData);
        },

        onsubtitlechange: function () {
            /* Sem legendas neste app. */
        },

        ondrmevent: function (drmEvent, drmData) {
            logInfo("Evento DRM: " + drmEvent + " / " + drmData);
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

    if (usandoPlaylistDeMidia) {
        if (tentativasPrepare >= MAX_PREPARE_ANTES_DE_FALLBACK) {
            /*
             * A chunklist tambem falhou. O nome dela e por sessao e expira,
             * entao voltar para a mestre faz o proximo ciclo re-resolver tudo
             * em vez de insistir numa URL morta.
             */
            logAviso("A playlist de mídia também falhou. Voltando para a playlist mestre.");
            usandoPlaylistDeMidia = false;
            tentativasPrepare = 0;
            urlAtual = urlMasterOriginal;
        }

        agendarReconexaoVideo(motivo);
        return;
    }

    if (tentativasPrepare < MAX_PREPARE_ANTES_DE_FALLBACK || !urlMasterOriginal) {
        agendarReconexaoVideo(motivo);
        return;
    }

    logAviso("Preparo falhou repetidamente. Tentando a playlist de mídia diretamente.");

    resolverPlaylistDeMidia(urlMasterOriginal, function (mediaUrl) {
        if (!appVisivel) {
            return;
        }

        if (mediaUrl && urlDeStreamingValida(mediaUrl)) {
            logInfo("Playlist de mídia resolvida. Reabrindo o player com ela.");
            usandoPlaylistDeMidia = true;
            tentativasPrepare = 0;
            urlAtual = mediaUrl;
            iniciarVideo(mediaUrl);
            return;
        }

        logAviso("Não foi possível resolver a playlist de mídia.");
        agendarReconexaoVideo(motivo);
    });
}

function agendarReconexaoVideo(motivo) {
    var atraso;

    if (!appVisivel) {
        return;
    }

    if (timerVideo !== null) {
        return;
    }

    playerPreparando = false;
    playerReproduzindo = false;
    tentativasVideo++;

    logAviso("Reconexão solicitada: " + motivo + ". Tentativa " + tentativasVideo + ".");

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

    /*
     * Fecha o recorte antes de esvaziar o plano de video. Sem isto haveria uma
     * janela entre este close() e o mostrarMensagem() de quem chamou em que a
     * tela ficaria transparente sobre um plano de video vazio.
     */
    marcarPlanoDeVideo(false);

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
        logAviso("AVPlay.stop ignorado: " + mensagemErro(stopError));
    }

    try {
        /* close() remove a instancia e volta ao estado NONE. */
        webapis.avplay.close();
    } catch (closeError) {
        /* Se ja estiver NONE, alguns firmwares lançam InvalidStateError. */
        logAviso("AVPlay.close ignorado: " + mensagemErro(closeError));
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
            logInfo("Reprodução pausada pelo controle remoto.");
        }
    } catch (e) {
        logAviso("Não foi possível pausar: " + mensagemErro(e));
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
            logInfo("Reprodução retomada pelo controle remoto.");
        }
    } catch (e) {
        logAviso("Não foi possível retomar: " + mensagemErro(e));
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
        logAviso("Não foi possível alternar Play/Pause: " + mensagemErro(e));
    }
}

/* Rede                                                                */

function configurarMonitoramentoDeRede() {
    if (!webapisDisponivel() || !webapis.network) {
        logAviso("Network API indisponível; o app seguirá usando erros das requisições/player.");
        return;
    }

    try {
        networkListenerId = webapis.network.addNetworkStateChangeListener(function (value) {
            logInfo("Network state: " + value);

            if (value === webapis.network.NetworkState.GATEWAY_DISCONNECTED) {
                redeConectada = false;
                tratarRedeDesconectada();
            } else if (value === webapis.network.NetworkState.GATEWAY_CONNECTED) {
                redeConectada = true;
                tratarRedeReconectada();
            }
        });
    } catch (e) {
        logAviso("Monitoramento de rede não configurado: " + mensagemErro(e));
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
        logAviso("Não foi possível consultar o gateway: " + mensagemErro(e));
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
    if (!appVisivel) {
        return;
    }

    mostrarMensagem("Conexão restabelecida. Reconectando...");
    agendarRetomada(1500);
}

/* Multitarefa                                                         */

function configurarMultitarefa() {
    document.addEventListener("visibilitychange", function () {
        if (document.hidden) {
            logInfo("Aplicativo em segundo plano.");
            appVisivel = false;

            cancelarTimers();
            abortarRequisicaoConfig();
            fecharPlayer();
            definirScreensaver(true);
        } else {
            logInfo("Aplicativo retornou ao primeiro plano.");
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
                logAviso("Erro ao alterar screensaver: " + mensagemErro(error));
            }
        );
    } catch (e) {
        logAviso("Screensaver não ajustado: " + mensagemErro(e));
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
        } else if (diagAberto) {
            tratado = tratarTeclaNoDiagnostico(keyCode);
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

                case KEY_UP:
                    contarToqueDeDiagnostico();
                    tratado = true;
                    break;

                default:
                    logInfo("Key code: " + keyCode);
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
                logInfo("Tecla registrada: " + teclas[i]);
            } catch (keyError) {
                logAviso("Tecla não registrada (" + teclas[i] + "): " + mensagemErro(keyError));
            }
        }
    } catch (e) {
        logAviso("TVInputDevice indisponível: " + mensagemErro(e));
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

    /*
     * Rede de seguranca: o popup nao interrompe mais a reconexao, mas se o
     * app chegar aqui sem player tocando e sem nada agendado, nada voltaria a
     * acontecer. Religar o fluxo evita ficar parado numa mensagem para sempre.
     */
    if (!playerReproduzindo && !playerPreparando &&
        timerVideo === null && timerConfig === null && timerRetomar === null) {
        logAviso("Popup fechado sem reprodução nem reconexão pendente. Religando o fluxo.");
        agendarRetomada(500);
    }
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
    logInfo("Saindo do SCTV-HD.");

    cancelarTimers();
    abortarRequisicaoConfig();
    fecharPlayer();
    definirScreensaver(true);

    try {
        if (typeof tizen !== "undefined" && tizen.application) {
            tizen.application.getCurrentApplication().exit();
        }
    } catch (e) {
        logErro("Erro ao sair do aplicativo: " + mensagemErro(e));
        exitPromptOpen = false;
    }
}

/* Diagnostico                                                         */

function contarToqueDeDiagnostico() {
    var agora = new Date().getTime();

    if (agora - ultimoToqueDiag > DIAG_JANELA_MS) {
        toquesDiag = 0;
    }

    ultimoToqueDiag = agora;
    toquesDiag++;

    if (toquesDiag >= DIAG_TOQUES) {
        toquesDiag = 0;
        abrirDiagnostico();
    }
}

function tratarTeclaNoDiagnostico(keyCode) {
    switch (keyCode) {
        case KEY_BACK:
        case KEY_ENTER:
            fecharDiagnostico();
            return true;

        default:
            return false;
    }
}

function abrirDiagnostico() {
    var painel = document.getElementById("diagPanel");
    var cabecalho = document.getElementById("diagCabecalho");
    var registro = document.getElementById("diagLog");

    if (!painel) {
        return;
    }

    if (cabecalho) {
        cabecalho.innerHTML = escaparHtml(
            "Versão " + APP_VERSION +
            "   Tizen " + infoPlataforma.tizen +
            "   Modelo " + infoPlataforma.modelo +
            "   Firmware " + infoPlataforma.firmware + "\n" +
            "Player " + estadoDoPlayer() +
            "   Playlist " + (usandoPlaylistDeMidia ? "chunklist" : "mestre") +
            "   Rede " + (redeConectada ? "ok" : "sem conexão") + "\n" +
            "URL " + (urlAtual || "nenhuma")
        );
    }

    if (registro) {
        registro.innerHTML = escaparHtml(logRing.join("\n"));
    }

    diagAberto = true;
    removerClasse(painel, "hidden");
}

function fecharDiagnostico() {
    var painel = document.getElementById("diagPanel");

    if (painel) {
        adicionarClasse(painel, "hidden");
    }

    diagAberto = false;
}

function estadoDoPlayer() {
    if (!webapisDisponivel() || !webapis.avplay) {
        return "AVPLAY_INDISPONIVEL";
    }

    try {
        return webapis.avplay.getState();
    } catch (e) {
        return "DESCONHECIDO";
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

    /* Camada opaca na frente: o recorte do plano de video nao serve para nada. */
    marcarPlanoDeVideo(false);
}

function esconderCarregamento() {
    var loadingLayer = document.getElementById("loadingLayer");

    if (loadingLayer) {
        adicionarClasse(loadingLayer, "hidden");
    }

    /* Sem camada opaca na frente: abre o recorte para o plano de video. */
    marcarPlanoDeVideo(true);
}

/*
 * Liga e desliga a transparencia do body. A invariante e simples: o body fica
 * transparente exatamente quando nenhuma camada opaca cobre a tela E o plano
 * de video tem conteudo. Ver comentario em css/style.css.
 */
function marcarPlanoDeVideo(visivel) {
    if (!document.body) {
        return;
    }

    if (visivel) {
        adicionarClasse(document.body, "tocando");
    } else {
        removerClasse(document.body, "tocando");
    }
}

/* Utilitarios                                                         */

/*
 * Todo log do app passa por aqui: alem do console (que exige o inspetor
 * remoto), as linhas ficam num buffer circular que o painel de diagnostico
 * mostra na propria TV.
 */
function registrarLog(nivel, texto) {
    var agora = new Date();

    logRing.push(
        ("0" + agora.getHours()).slice(-2) + ":" +
        ("0" + agora.getMinutes()).slice(-2) + ":" +
        ("0" + agora.getSeconds()).slice(-2) +
        " " + nivel + " " + texto
    );

    if (logRing.length > LOG_MAX) {
        logRing.shift();
    }
}

function logInfo(texto) {
    registrarLog("I", texto);
    console.log(texto);
}

function logAviso(texto) {
    registrarLog("A", texto);
    console.warn(texto);
}

function logErro(texto) {
    registrarLog("E", texto);
    console.error(texto);
}

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

        if (!appVisivel) {
            return;
        }

        logErro(
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