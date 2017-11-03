import config     from './config.json';
import gulp       from 'gulp';
import plugins    from 'gulp-load-plugins';
import browser    from 'browser-sync';
import rimraf     from 'rimraf';
import panini     from 'panini';
import yargs      from 'yargs';
import lazypipe   from 'lazypipe';
import inky       from 'inky';
import fs         from 'fs';
import siphon     from 'siphon-media-query';
import path       from 'path';
import merge      from 'merge-stream';
import beep       from 'beepbeep';
import colors     from 'colors';
import pug        from 'gulp-pug';
import nodemailer from 'nodemailer';
import bulkSass   from 'gulp-sass-bulk-import';
import util       from 'gulp-util';
import html_strip from 'htmlstrip-native';
import prompt     from 'gulp-prompt';
import rename     from 'gulp-rename';

const dir = {
  dist: './dist',
  src: './src',
  tmp: './_tmp'
}

let sendTemplate;
let sendList;
let awsDir;

const $ = plugins();

// Look for the --production flag
const PRODUCTION = !!(yargs.argv.production);

// Build the "dist" folder by running all of the above tasks
gulp.task('build',
  gulp.series(clean, views, pages, sass, images, inline, cleanTmp));

// Build emails, run the server, and watch for file changes
gulp.task('default',
  gulp.series('build', server, watch));

// Build emails, then zip
gulp.task('zip',
  gulp.series('build', zip));

// Upload email
gulp.task('upload',
  gulp.series('build', aws, link));

// Build, upload and send emails
gulp.task('send',
  gulp.series('upload', chooseTemplate, chooseList, replaceImagePaths, deliverEmail));


// Delete the "dist" folder
// This happens every time a build starts
function clean(done) {
  rimraf('dist', done)
  rimraf('_tmp', done)
}
function cleanTmp(done) {
  rimraf('_tmp', done)
}

// Compile Pug files into html layouts
function views() {
  return gulp.src('src/**/*.pug')
    .pipe(pug())
    .pipe(gulp.dest('_tmp'));
}

// Compile layouts, pages, and partials into flat HTML files
function pages() {
  return gulp.src('_tmp/pages/**/*.html')
    .pipe(panini({
      root: '_tmp/pages',
      layouts: '_tmp/layouts',
      partials: '_tmp/partials',
      helpers: '_tmp/helpers',
      data: 'src/data'
    }))
    .pipe(inky())
    .pipe(gulp.dest('dist'));
}

// Reset Panini's cache of layouts and partials
function resetPages(done) {
  panini.refresh();
  done();
}

// Compile Sass into CSS
function sass() {
  return gulp.src('src/assets/scss/*.scss')
    .pipe($.if(!PRODUCTION, $.sourcemaps.init()))
    .pipe(bulkSass())
    .pipe($.sass({
      includePaths: ['node_modules/foundation-emails/scss']
    }).on('error', $.sass.logError))
    .pipe($.if(!PRODUCTION, $.sourcemaps.write()))
    .pipe(gulp.dest('dist/css'));
}

// Copy and compress images
function images() {
  return gulp.src('src/assets/img/**/*')
    .pipe($.imagemin())
    .pipe(gulp.dest('./dist/assets/img'));
}

// Inline CSS and minify HTML
function inline() {
  return gulp.src('dist/**/*.html')
    .pipe($.if(PRODUCTION, inliner('dist/css/app.css')))
    .pipe(gulp.dest('dist'));
}

// Start a server with LiveReload to preview the site in
function server(done) {
  browser.init({
    server: 'dist'
  });
  done();
}

// Watch for file changes
function watch() {
  gulp.watch('src/**/**/*.pug').on('change', gulp.series(views, resetPages, pages, sass, inline,cleanTmp, browser.reload));
  gulp.watch(['src/layouts/**/*', 'src/partials/**/*', 'src/data/**/*']).on('change', gulp.series(views, resetPages, pages, inline,cleanTmp, browser.reload));
  gulp.watch(['../scss/**/*.scss', 'src/assets/scss/**/*.scss']).on('change', gulp.series(views, resetPages, sass, pages, inline,cleanTmp, browser.reload));
  gulp.watch('src/assets/img/**/*').on('change', gulp.series(images, browser.reload));
}

// Inlines CSS into HTML, adds media query CSS into the <style> tag of the email, and compresses the HTML
function inliner(css) {
  var css = fs.readFileSync(css).toString();
  var mqCss = siphon(css);

  var pipe = lazypipe()
    .pipe($.inlineCss, {
      applyStyleTags: false,
      removeStyleTags: false,
      removeLinkTags: false,
      applyWidthAttributes: true,
    })
    .pipe($.replace, '<!-- <style> -->', `<style>${mqCss}</style>`)
    .pipe($.replace, '<link rel="stylesheet" type="text/css" href="css/app.css">', '')
    .pipe($.htmlmin, {
      collapseWhitespace: true,
      minifyCSS: true
    });

  return pipe();
}

// Copy and compress into Zip
function zip() {
  var dist = 'dist';
  var ext = '.html';

  function getHtmlFiles(dir) {
    return fs.readdirSync(dir)
      .filter(function(file) {
        var fileExt = path.join(dir, file);
        var isHtml = path.extname(fileExt) == ext;
        return fs.statSync(fileExt).isFile() && isHtml;
      });
  }

  var htmlFiles = getHtmlFiles(dist);

  var moveTasks = htmlFiles.map(function(file){
    var sourcePath = path.join(dist, file);
    var fileName = path.basename(sourcePath, ext);

    var moveHTML = gulp.src(sourcePath)
      .pipe($.rename(function (path) {
        path.dirname = fileName;
        return path;
      }));

    var moveImages = gulp.src(sourcePath)
      .pipe($.htmlSrc({ selector: 'img'}))
      .pipe($.rename(function (path) {
        path.dirname = fileName + '/assets/img';
        return path;
      }));

    return merge(moveHTML, moveImages)
      .pipe($.zip(fileName+ '.zip'))
      .pipe(gulp.dest('dist'));
  });

  return merge(moveTasks);
}

// Choose template (all, index.html, version2.html)
function getFiles(dir) {
  return fs.readdirSync(dir)
    .filter(function(file) {
        return !fs.statSync(path.join(dir, file)).isDirectory();
    });
}
function chooseTemplate() {
    if (fs.existsSync(dir.dist)) {
        let fileList = getFiles(dir.dist);
        if (fileList.length > 0) {
            return gulp.src('./')
                .pipe(prompt.prompt({
                    type: 'list',
                    name: 'fileList',
                    message: 'Choose email template.',
                    choices: fileList 
                }, function(res) {
                      util.log(util.colors.green('Template selected: ' + res.fileList));
                      sendTemplate = res.fileList
                }));
        }
    }
}

// Choose list (default)
function chooseList() {
  if (config.testing.lists) {
      let testingLists = Object.keys(config.testing.lists);
      return gulp.src('./')
          .pipe(prompt.prompt({
              type: 'list',
              name: 'sendList',
              message: 'Choose list to send to.',
              choices: testingLists
          }, function(res) {
                util.log(util.colors.green('List selected: ' + res.sendList));
                sendList = config.testing.lists[res.sendList]
          }));
    }
}

// Upload files to S3
function aws() {
  let publisher = !!config.aws ? $.awspublish.create(config.aws) : $.awspublish.create();
  let headers = {
    'Cache-Control': 'max-age=315360000, no-transform, public'
  }
  return gulp.src('./dist/**/*')
    // Set directory
    // eg. /2017/nab/nar0000-edm/assets/css/
    .pipe(rename((path) => {
        awsDir = config.meta.year + '/' + config.meta.client + '/' + config.meta.job + '/' + path.dirname
        path.dirname = '/' + awsDir
    }))
    // publisher will add Content-Length, Content-Type and headers specified above
    // If not specified it will set x-amz-acl to public-read by default
    .pipe(publisher.publish(headers))
    // create a cache file to speed up consecutive uploads
    .pipe(publisher.cache())
    // Delete old job files
    .pipe(publisher.sync(config.meta.year + '/' + config.meta.client + '/' + config.meta.job))
    // print upload updates to console
    .pipe($.awspublish.reporter());
}

// Report Link
function link () {
  return gulp.src('./')
    .on('end', () => {
      util.log('Staging Link: (Hold CMD + LeftClick on link)')
      util.log(config.aws.url + '/' + config.meta.year + '/' + config.meta.client + '/' + config.meta.job)
    })
}

// Convert image paths to AWS
function replaceImagePaths() {
  let awsURL = !!config && !!config.aws && !!config.aws.url ? config.aws.url : false;
  awsURL = awsURL + '/' + awsDir
  return gulp.src('dist/**/*.html')
    .pipe($.if(!!awsURL, $.replace(/=('|")(\/?assets\/img)/g, "=$1"+ awsURL)))
    .pipe(gulp.dest('dist'))
    .on('end', () => {
      util.log('Replaced paths with:', awsURL)
    })

}

// Send email
function deliverEmail() {
  return gulp.src('./')
    .on('end', () => {
      util.log('Sending: ', sendTemplate)
      util.log('To: ', sendList)
      return sendEmail(sendTemplate, sendList)
    })
}

// Reusable email †ransport function
function sendEmail(template, recipient) {
  try {
      var options = {
          include_script : false,
          include_style : false,
          compact_whitespace : true,
          include_attributes : { 'alt': true }
      };

      var templatePath = "./dist/" + template;

      var transporter = nodemailer.createTransport({
          service: 'Mailgun',
          auth: {
              user: config.mailgun.user,
              pass: config.mailgun.pass
          }
      });

      var encoding = 'utf8'
      var templateContent = fs.readFileSync(templatePath, encoding='utf8');

      var mailOptions = {
          from: config.testing.from, // sender address
          to: recipient, // list of receivers
          subject: config.meta.job + ' - ' + template, // Subject line
          html: templateContent, // html body
          text: html_strip.html_strip(templateContent, options)
      };

      transporter.sendMail(mailOptions, function(error, info){
          if(error){
              return util.log(error);
          } else {
              return util.log('Message sent: ' + info.response);
          }
      });
  } catch (e) {
      if(e.code == 'ENOENT') {
          util.log('There was an error. Check your template name to make sure it exists in ./dist');
      } else if(e instanceof TypeError) {
          util.log('There was an error. Please check your config.json to make sure everything is spelled correctly');
      } else {
          util.log(e);
      }
  }
}
