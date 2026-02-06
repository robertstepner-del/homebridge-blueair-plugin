module.exports = (api) => {
  // Register the static directory for the custom UI
  api.registerPlatformUI({
    path: '/blueair-ui',
    static: require('path').resolve(__dirname, 'static'),
    index: 'index.html',
    label: 'Blueair Plugin UI',
  });
};
