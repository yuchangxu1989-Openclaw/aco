const helloPlugin = {
  id: 'aco-hello-plugin',
  name: 'Hello Plugin',
  version: '1.0.0',

  register(api) {
    api.on('before_prompt_build', async (_event) => {
      api.logger.info('[HelloPlugin] hello from ACO plugin!');
      return null;
    }, { priority: 100 });

    api.logger.info('[HelloPlugin] plugin registered successfully');
  },
};

export default helloPlugin;
