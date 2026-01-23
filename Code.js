function doGet(e) {
  // Cria o template a partir do arquivo 'index'
  return HtmlService.createTemplateFromFile('index')
      .evaluate()
      .setTitle('BBU Architect Simulator (Training Edition)')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Esta função permite importar o CSS e o JS para dentro do HTML
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename)
      .getContent();
}

// Função chamada pelo JavaScript para baixar o manual
function getManualPDFData() {
  try {
    // 1. Carrega o conteúdo do arquivo 'Manual.html'
    var htmlOutput = HtmlService.createHtmlOutputFromFile('Manual');
    var content = htmlOutput.getContent();
    
    // 2. Cria um Blob (arquivo virtual) do tipo HTML
    var blob = Utilities.newBlob(content, MimeType.HTML, "Manual_Tecnico_BBU5900.html");
    
    // 3. Converte o HTML para PDF usando o serviço nativo do Google
    var pdfBlob = blob.getAs(MimeType.PDF);
    
    // 4. Retorna os dados para o navegador baixar
    return {
      filename: "Manual_Tecnico_BBU5900.pdf",
      mime: "application/pdf",
      data: Utilities.base64Encode(pdfBlob.getBytes())
    };
  } catch (e) {
    throw new Error("Erro ao gerar PDF: " + e.message);
  }
}
function getConteudoSimulador() {
  // Pega o conteúdo do arquivo HTML e retorna como string
  return HtmlService.createHtmlOutputFromFile('Simulador').getContent();
}
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}