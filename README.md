# Optimal Foundry

Módulo para Foundry VTT (v14 ou mais novo, testado na 14.370) que deixa o mundo mais leve e mais rápido de carregar para todo mundo. Tudo roda no navegador: não há servidor extra nem programa para instalar.

## O que ele faz

- **Otimiza cada upload.** Antes de o arquivo chegar ao servidor, o navegador converte:
  - imagens para **WebP** (SVG nunca é tocado; WebP e AVIF ficam como estão);
  - vídeos para **WebM VP9** (com transparência quando o original tem);
  - áudio para **Ogg Opus**.
  Só a versão otimizada é guardada. Se o navegador de quem enviou não consegue converter, o original sobe e o mestre converte depois, em segundo plano.
- **Otimiza o acervo que já existe, do jeito que você escolher.** O cliente do mestre converte a mídia que o mundo usa e aponta cenas, atores, diários, playlists etc. para as cópias novas. Três modos: **Automático** (converte tudo aos poucos, sem perguntar), **Revisar antes** (o padrão: lista o que seria convertido e só mexe no que você aprovar, na aba Mídia do painel) e **Não otimizar**. A otimização **não mexe nos originais**, e qualquer troca pode ser desfeita pelo painel. Só a Limpeza (opcional, no painel) esvazia originais, e ela não tem volta.
- **Mantém a resolução por padrão.** Muda só o formato e a qualidade. Reduzir tamanho é opcional.
- **Coordena a rede.** O mestre distribui a banda entre os jogadores, limita downloads simultâneos (útil em túneis gratuitos) e faz quem entra junto carregar a cena um de cada vez.
- **Pré-carrega sozinho no tempo ocioso.** Quando ninguém está baixando nada, os jogadores buscam com antecedência o que devem precisar, do mais provável para o menos provável: as cenas que os jogadores e o mestre estão vendo, o resto da cena ativa e a playlist dela, o que está tocando, as cenas vizinhas na barra de navegação e na pasta, os destinos de teleporte, depois o resto da barra, as fichas dos personagens dos jogadores e, por fim, todas as outras cenas, playlists e diários visíveis aos jogadores. Não precisa marcar nada; marcar uma cena (botão direito na aba Cenas) só faz ela passar na frente.
- **Aproveita um CDN** (como o Cloudflare) quando existe: detecta sozinho e libera mais banda.
- **Troca arquivos entre jogadores (P2P).** Quem já tem um arquivo otimizado pode enviá-lo direto para os outros, poupando o upload de quem hospeda. Cada arquivo é conferido por hash antes de ser usado.
- **Cache local** com Service Worker: arquivos otimizados ficam guardados no navegador e não são baixados de novo. As outras mídias (que podem mudar) também ficam guardadas, mas são conferidas com o servidor antes de usar, no máximo a cada 30 segundos.

## Instalação

1. Instale e ative o módulo **libWrapper** (obrigatório).
2. No Foundry, em *Módulos adicionais → Instalar módulo*, procure **Optimal Foundry** ou cole a URL do manifesto:
   `https://github.com/Jpkovas/optimal-foundry/releases/latest/download/module.json`
3. Ative o módulo no mundo.
4. Entre como mestre: a tela de boas-vindas aparece para você escolher como o módulo funciona. O painel completo fica em *Configurações → Configurar opções → Optimal Foundry → Abrir painel*.

Navegadores dos jogadores: Chrome, Edge ou Firefox atualizados. O cache local e o P2P exigem **HTTPS** (ou acesso pelo `localhost`); em `http://IP:30000` eles ficam desligados, e o resto funciona normalmente.

## Boas-vindas

Na primeira vez que um mestre entra no mundo com o módulo ativo, aparece uma tela para escolher como ele funciona: a qualidade dos arquivos (os mesmos presets das configurações), o que fazer com os arquivos que o mundo já tem (revisar antes, automático ou não mexer), se os envios novos já sobem leves, o pré-carregamento automático, o P2P, a velocidade de upload de quem hospeda e o painel flutuante. **Enquanto ninguém concluir essa tela, nenhum arquivo existente é convertido**; o pré-carregamento e o P2P já funcionam com o padrão. *Agora não* fecha a tela, que volta na próxima entrada. Dá para abrir de novo pelo botão *Boas-vindas* nas configurações do módulo.

## Painel flutuante (só o mestre)

Uma caixinha sobre o mapa que mostra, a cada 2 segundos:

- o que está acontecendo com os arquivos (convertendo qual arquivo e quanto falta, quantos esperam sua aprovação, pausado, tudo em dia);
- cada jogador conectado, com uma barra de quanto ele já tem do que vem a seguir (as cenas que alguém está vendo, a cena ativa, as vizinhas e o que está tocando) e se está entrando na cena ou baixando agora; passe o mouse para ver os detalhes;
- a fila do pré-carregamento (agora, prováveis, depois) e o P2P.

Arraste pela barra de título para colocar onde quiser; a posição fica guardada neste navegador. A seta recolhe tudo numa linha só: o ícone dos arquivos com o progresso ou quantos esperam aprovação, uma bolinha colorida por jogador (verde pronto, azul baixando, laranja entrando ou ainda baixando o que vem, contorno quando não há informação) e as conexões P2P. O ícone ao lado da seta abre o painel completo e o X esconde. Ele volta pelo botão de medidor na barra de **Tokens**, à esquerda. Jogadores nunca veem.

## O painel

Só o mestre abre. Atualiza a cada 2 segundos.

- **Mídia:** no modo *Revisar antes*, primeiro a lista do que **espera sua aprovação**, com onde cada arquivo é usado e um botão para ver a imagem ou o vídeo; marque e escolha *Otimizar marcados*, *Otimizar todos* ou *Deixar como está* (esses não aparecem mais; *Tentar de novo* na lista de arquivos traz de volta). Depois, uma tabela com **tudo o que o mundo usa**, separada por origem (pasta do mundo, módulos, sistema, ícones e sons do Foundry, outras pastas) e pelo que aconteceu com cada arquivo (otimizado, já leve, na fila, esperando você, pulado, com falha), mais o que não é lido e por quê (links externos, SVG, compêndios de módulos). Depois, quanto já foi otimizado e economizado, o que o navegador consegue converter, o andamento da otimização do acervo (varrer, iniciar, pausar, desfazer tudo) e a lista de todos os arquivos, com filtro e o motivo de cada um pulado ou com falha. Cada arquivo otimizado pode voltar ao original individualmente; arquivos com falha ou pulados podem ser tentados de novo, um a um ou a lista filtrada inteira, e arquivos restaurados podem ser otimizados de novo sem converter outra vez.
- **Rede:** perfil em uso, limites, resultado da detecção de CDN (e quem mediu) e uma tabela por jogador: downloads em andamento, velocidade, cena pronta, quanto do que vem a seguir ele já tem, pré-carregamento, P2P e a posição na fila de entrada. Jogadores sem notícia recente aparecem apagados.
- **P2P:** estado do Service Worker (versão, aviso de cópia desatualizada, armazenamento persistente) e do cache, pares conectados, quanto foi enviado e recebido e a última falha de conexão.
- **Pré-carregamento:** a previsão automática, com o que está na fila, quando (agora, provável, nesta sessão, depois) e por quê; as cenas que você quer passar na frente (opcional); e as pastas e playlists que entram sempre ou nunca.
- **Limpeza:** esvazia os originais que já foram substituídos (veja abaixo).

Iniciar e Pausar ficam gravados: depois de pausar, a otimização do acervo não volta sozinha ao recarregar (aprovar arquivos na revisão também retoma). Ela também espera enquanto algum jogador está entrando ou carregando uma cena.

Na aba **Cenas**, o botão direito em uma cena mostra *Marcar como próxima cena* / *Desmarcar*. Cenas marcadas ganham um pequeno ícone azul.

## Limpeza dos originais

Depois que o acervo está convertido, os originais continuam no disco. O Foundry não deixa módulos apagarem arquivos, mas deixa sobrescrever imagens, vídeos e sons. Por isso a aba **Limpeza** do painel **esvazia** os originais: cada um continua na pasta com o mesmo nome, mas fica com 0 bytes e para de ocupar espaço. Só aparecem os que já podem ser esvaziados:

- só arquivos **dentro da pasta deste mundo** (`worlds/<mundo>/`); arquivos em pastas compartilhadas do Data nunca entram, porque outros mundos podem usá-los;
- já convertidos e que nada no mundo menciona mais: cenas, fichas, diários, playlists, macros, mensagens do chat, configurações e compêndios do mundo (qualquer menção ao arquivo, mesmo num texto, já basta para ele ficar);
- com a versão otimizada presente e do tamanho registrado.

Clique em **Analisar**, marque os arquivos (ou use **Esvaziar todos**) e confirme. Tudo acontece pelo navegador, sem terminal, em qualquer servidor, na sessão do mestre que coordena a otimização. Enquanto a limpeza roda, *Desfazer* fica bloqueado. Antes de esvaziar cada arquivo, o módulo confere de novo que nada voltou a usá-lo, que ele não mudou desde a conversão e que a versão otimizada baixa inteira, com o tamanho e o SHA-256 registrados. O que não passa fica como está e aparece em *Mantidos*, com o motivo.

**Outros mundos não são verificados.** Se outro mundo usa arquivos da pasta deste, não esvazie esses arquivos.

**Não tem volta:** o conteúdo do original some. As cenas, fichas e playlists continuam com as versões otimizadas, e *Desfazer* deixa de valer para esses arquivos. Se algum documento voltar a apontar para um original esvaziado (por exemplo, colado de um backup), o módulo troca a referência pela versão otimizada, como faz com qualquer arquivo já convertido.

## Minha conexão (para todos)

Cada jogador (e o mestre) pode abrir **Minha conexão** pelo ícone de wi-fi na lista de jogadores (ao lado da latência e do FPS) ou em *Configurar opções → Optimal Foundry*. A janela mostra o que vale para **este aparelho**: quanto do cache local está em uso, se o P2P está ligado (pares, enviado e recebido), o andamento do pré-carregamento, o CDN e o Service Worker. Ali dá para mudar as quatro opções deste aparelho (veja Configurações) e **limpar o cache deste aparelho** (os arquivos são baixados de novo quando precisar).

## Configurações

Em *Configurar opções → Optimal Foundry*, o mestre vê três botões: **Configurações**, **Painel** e **Minha conexão**. Os jogadores veem só **Minha conexão**: tudo o que o módulo faz com os arquivos e com a rede do mundo é decidido pelo mestre e vale para todos, inclusive para os uploads dos jogadores.

A janela **Configurações** começa pelos presets. Clicar num preset só preenche o formulário; nada muda até clicar em **Salvar**:

| Preset | Para quem |
|---|---|
| **Recomendado** | Quase todo mundo: qualidade quase igual à original, arquivos bem menores, sem mudar o tamanho das imagens. |
| **Economia máxima** | Internet fraca ou muitos jogadores: qualidade um pouco menor, imagens limitadas a 4096 px, vídeos a 720p e sem som. |
| **Qualidade máxima** | Internet boa e exigência de detalhe: comprime pouco. |
| **Não mexer nos arquivos** | Quem não quer nenhum arquivo convertido: usa só o pré-carregamento e o compartilhamento entre jogadores. |

As explicações de cada opção aparecem ao passar o mouse no ponto de interrogação ao lado do nome. Embaixo ficam **O essencial**, com oito opções explicadas em linguagem simples (otimizar arquivos, o que for enviado, o que fazer com os arquivos que o mundo já tem, manter o tamanho, como os jogadores chegam até você, a velocidade de upload da sua internet, baixar as próximas cenas antes e compartilhar entre jogadores), e **Avançado**, fechado por padrão, com os ajustes técnicos agrupados em Arquivos, Rede e carregamento e Compartilhamento e cache. **Valores padrão** volta tudo ao recomendado.

Duas observações:
- *Como os jogadores chegam até você* em **Automático** descobre sozinho se há um CDN. Os ajustes finos de rede só valem em **Personalizado** e ficam apagados nos outros perfis.
- Mudar *Otimizar arquivos*, *Compartilhar entre jogadores* ou *Guardar arquivos no navegador* pede para recarregar o Foundry de todos.

Em **Minha conexão**, cada pessoa ajusta só o próprio aparelho: baixar as próximas cenas neste aparelho, compartilhar arquivos com os colegas, velocidade máxima de envio aos colegas e espaço para guardar arquivos.
## Como o pré-carregamento divide a banda

- O mestre monta uma fila única, em quatro níveis: **agora** (cenas marcadas, a cena que o mestre está preparando e as que os jogadores estão vendo), **provável** (o resto da cena ativa e a playlist dela, o que está tocando, as vizinhas na barra de navegação e na pasta, os destinos de teleporte e o que está em *Sempre*), **nesta sessão** (o resto da barra de navegação, as playlists das cenas acima e as imagens dos personagens dos jogadores) e **depois** (todo o resto do mundo, inclusive cenas e playlists escondidas, que o mestre pode ativar a qualquer momento). A fila se refaz sozinha quando a cena ativa muda, quando alguém troca de cena (conferido a cada 3 segundos) ou quando algo é editado.
- A fila cobre tudo, mas o ritmo é controlado: a *Banda para pré-carregamento*, o P2P entre jogadores e o espaço no navegador de cada um decidem até onde ela vai. Um navegador quase cheio para de baixar o nível *depois*.
- Quando um jogador fica ocioso, pede ao mestre um lote de até 8 arquivos. O mestre já desconta o lote do orçamento de upload (*Banda para pré-carregamento*) antes de responder; arquivos grandes saem sozinhos. Não há um pedido por arquivo.
- Ninguém recebe lote enquanto outro jogador está entrando ou carregando uma cena. Quando um jogador abre uma cena, o pré-carregamento dele para na hora (menos os downloads já passados da metade).
- Com P2P e sem CDN, cada arquivo grande vai do servidor para um jogador só; os outros pegam dele.
- Navegadores que acessam pelo `localhost` (normalmente o mestre no servidor) não pré-carregam: não economizaria nada.

## Nomes dos arquivos otimizados

Cada cópia otimizada se chama `<nome>.of-<8 caracteres do hash>.<extensão>`, por exemplo `taverna.of-3fa9c21b.webp`. Ela fica na mesma pasta do original. Originais dentro de `modules/` ou `systems/` ganham a cópia em `optimal-foundry/<pasta original>/`, na raiz de Data.

Como o nome muda sempre que o conteúdo muda, esses arquivos podem ficar em cache por um ano sem risco de mostrar versão velha. É isso que as regras de CDN abaixo aproveitam.

## Receita para quem tem domínio no Cloudflare

Exemplo com o endereço `rpg.seudominio.com`; troque pelo seu.

### 1. Túnel nomeado

```sh
cloudflared tunnel login                      # uma vez, gera ~/.cloudflared/cert.pem
cloudflared tunnel create foundry             # cria o túnel e ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns foundry rpg.seudominio.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /caminho/para/.cloudflared/<UUID>.json
ingress:
  - hostname: rpg.seudominio.com
    service: http://localhost:30000
    originRequest:
      connectTimeout: 10s
      keepAliveConnections: 100
      keepAliveTimeout: 90s
  - service: http_status:404
```

Rode com `cloudflared tunnel run foundry` ou instale como serviço (`cloudflared service install`).

No `options.json` do Foundry: `"hostname": "rpg.seudominio.com"`, `"proxySSL": true`, `"proxyPort": 443` e `"upnp": false`.

### 2. Regras de cache (Caching → Cache Rules)

O Foundry manda `Cache-Control: no-cache` em tudo, então o Cloudflare só guarda os arquivos se uma regra mandar.

**Regra 1: arquivos otimizados (imutáveis).**
- Quando: `(http.host eq "rpg.seudominio.com" and http.request.uri.path contains ".of-" and http.request.uri.path.extension in {"webp" "webm" "ogg"})`
- Cache: *Eligible for cache*. Edge TTL: *Ignore cache-control header*, 1 ano. Browser TTL: *Override origin*, 1 ano.

**Regra 2: outras mídias do mundo (podem mudar).**
- Quando: `(http.host eq "rpg.seudominio.com" and not (http.request.uri.path contains ".of-") and http.request.uri.path.extension in {"png" "jpg" "jpeg" "webp" "gif" "svg" "mp3" "ogg" "wav" "m4a" "webm" "mp4"})`
- Cache: *Eligible for cache*. Edge TTL: 2 horas. Browser TTL: *Respect origin*.
- Atenção: o Foundry sobrescreve em silêncio um arquivo de mídia enviado com o mesmo nome. Com esta regra, a versão antiga pode aparecer por até 2 horas. Se isso incomodar, use um TTL menor ou não crie esta regra.

Confira as duas no simulador de regras do Cloudflare antes de jogar.

### 3. Cabeçalho do Service Worker (Rules → Transform Rules → Modify Response Header)

- Quando: `http.request.uri.path eq "/modules/optimal-foundry/sw.js"`
- Ação: *Set static*, cabeçalho `Service-Worker-Allowed`, valor `/`.

Sem esse cabeçalho, o navegador não deixa o Service Worker do módulo cuidar do site inteiro. Se o Foundry usa um prefixo de rota (`routePrefix`), use esse prefixo no caminho e no valor (por exemplo `/rpg/modules/optimal-foundry/sw.js` e `/rpg/`).

### 4. Arquivos do Foundry e dos módulos (opcional, recomendado)

O Service Worker não guarda os arquivos de código do Foundry. Uma regra de cache no Cloudflare tira esse peso do upload de quem hospeda, principalmente quando todos entram ao mesmo tempo.

- Quando: `(http.host eq "rpg.seudominio.com" and (starts_with(http.request.uri.path, "/scripts/") or starts_with(http.request.uri.path, "/css/") or starts_with(http.request.uri.path, "/lang/") or starts_with(http.request.uri.path, "/fonts/") or starts_with(http.request.uri.path, "/modules/") or starts_with(http.request.uri.path, "/systems/")) and http.request.uri.path.extension in {"js" "mjs" "css" "json" "hbs" "html" "woff" "woff2" "ttf" "otf"} and not ends_with(http.request.uri.path, "/sw.js"))`
- Cache: *Eligible for cache*. Edge TTL: *Ignore cache-control header*, 1 dia. Browser TTL: *Respect origin* (o navegador continua conferindo, mas quem responde é o Cloudflare).
- O Foundry não põe versão nesses endereços. **Depois de atualizar o Foundry, um sistema ou um módulo, faça *Caching → Configuration → Purge Everything*** (ou espere um dia). O `sw.js` fica de fora para que uma versão nova do módulo chegue logo.

### Termos do Cloudflare

Nos planos Free, Pro e Business, os termos do CDN do Cloudflare pedem serviços pagos (Stream, R2 etc.) para servir vídeo ou uma parte desproporcional de arquivos grandes, e o Cloudflare pode limitar a conta se isso acontecer. Um grupo pequeno de jogo dificilmente chama atenção, mas o risco existe. Se preferir não correr esse risco, tire `webm` e `mp4` das regras acima.

## Receita sem domínio (sem CDN, sem cabeçalho)

Funciona com túnel rápido, IP direto com HTTPS ou rede local com HTTPS.

1. Copie o arquivo `Data/modules/optimal-foundry/sw.js` para a raiz de Data com o nome **`optimal-foundry-sw.js`** (fica em `Data/optimal-foundry-sw.js`).
2. Recarregue o mundo.

O Foundry serve esse arquivo em `/optimal-foundry-sw.js`, um caminho que pode cuidar do site inteiro sem cabeçalho especial. O módulo tenta esse endereço primeiro; se não existir, tenta o arquivo do módulo; se nenhum funcionar, segue sem cache local (o resto do módulo continua funcionando). Ao atualizar o módulo, copie o `sw.js` de novo.

Sem CDN, o perfil automático fica em *Túnel rápido*: o mestre segura a banda e o P2P alivia o upload de quem hospeda.

Ao atualizar o módulo, se o painel mostrar o Service Worker como **desatualizado**, a cópia em `Data/optimal-foundry-sw.js` ficou velha: copie o `sw.js` de novo.

## Testar com vários jogadores no mesmo computador

Cada endereço (`http://localhost:30000`, `http://127.0.0.1:30000`, `http://[::1]:30000`, o domínio público) tem seus próprios cookies, cache e Service Worker, então dá para abrir um jogador em cada um no mesmo Chrome. Como endereços locais ficam fora do P2P de propósito, ative o P2P para o teste no console de cada aba local:

```js
localStorage["optimal-foundry.debug.allowLocalP2P"] = "1"; // depois recarregue; remova com localStorage.removeItem(...)
```

Se os pares do mesmo computador nunca conectarem, abra o Chrome com `--disable-features=WebRtcHideLocalIpsWithMdns`. A aba P2P do painel mostra a última falha com os tipos de candidato ICE.

## Limitações

- **O módulo não apaga arquivos.** O Foundry não oferece forma de um módulo apagar arquivos: a Limpeza só consegue esvaziar os originais (0 bytes, mesmo nome), então os nomes continuam aparecendo nas pastas. Desfazer só re-aponta os documentos; as cópias otimizadas também ficam. Um arquivo desfeito fica marcado como restaurado e não é otimizado de novo sozinho; use *Otimizar de novo* no painel para mudar isso.
- **Uploads pelo túnel do Cloudflare** têm limite de 100 MB por arquivo nos planos Free e Pro. Arquivos maiores mesmo depois de convertidos precisam ser enviados pelo `localhost` de quem hospeda.
- **GIFs animados** enviados ficam como estão (não dá para saber onde serão usados). No acervo, viram vídeo só quando aparecem apenas em tiles e tokens.
- **Imagens com mais de 16383 px** de lado são puladas quando a resolução é mantida (limite do WebP).
- **Safari não é suportado** para converter (não gera WebP de verdade). Jogadores no Safari ainda jogam, mas os uploads deles são convertidos pelo mestre.
- **HTTP sem HTTPS:** cache local e P2P desligam sozinhos.
- **P2P** usa só STUN por padrão. Em redes muito fechadas a conexão direta pode falhar; nesse caso o arquivo vem do servidor normalmente. Um servidor TURN pode ser adicionado em *Servidores ICE*. A conexão direta deixa os outros jogadores do mundo verem o endereço IP do seu navegador; desligar o P2P evita isso. Navegadores que acessam o servidor pelo `localhost` ou pela rede local (normalmente o mestre no computador do servidor) não participam do P2P, porque o upload deles dividiria o link do servidor.
- **Uma sessão coordena.** A otimização do acervo, a fila de pré-carregamento, o rastreador do P2P e a fila de entrada rodam só em uma sessão do mestre ativo: se ele abrir duas abas, ou o app e o navegador, só a mais antiga coordena e a outra fica passiva. Se a sessão que coordena fechar, a outra assume na hora (ou em até 75 segundos se ela travar). Tudo isso só funciona com o mestre conectado; é melhor deixá-lo conectado pelo `localhost`, longe dos limites do túnel.
- **Arquivo trocado com o mesmo nome.** Se um original que ainda é usado em algum documento for substituído no servidor por outro arquivo com o mesmo nome, a otimização percebe pela assinatura do arquivo (ETag) e converte de novo, em vez de apontar para a cópia antiga.

## Publicar uma versão nova (para quem mantém o módulo)

1. Suba o número em `version` no `module.json` (e o `download`, que aponta para a tag `v<versão>`), faça o commit e envie.
2. No GitHub, crie um release com a tag `v<versão>` (por exemplo `v0.2.0`).
3. O workflow `.github/workflows/release.yml` confere que a tag bate com o `module.json`, gera o `module.zip` só com os arquivos que o Foundry usa e anexa `module.json` e `module.zip` ao release. O link `releases/latest/download/module.json` passa a apontar para a versão nova, e quem já instalou recebe a atualização pelo Foundry.
4. Se o segredo `FOUNDRY_RELEASE_TOKEN` estiver configurado no repositório (*Settings → Secrets and variables → Actions*), com o token da página do pacote em foundryvtt.com, o workflow também registra a versão na biblioteca oficial do Foundry.

## Licença

MIT. Inclui o Mediabunny (MPL-2.0) em `vendor/`.
